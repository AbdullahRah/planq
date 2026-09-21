import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { parsePdf } from '@/lib/parsers/pdf';
import { parseImage } from '@/lib/parsers/image';
import { parseDxf, DwgUnsupportedError } from '@/lib/parsers/dxf';
import { extractSheetFromImage, mergeExtraction, delay } from '@/lib/extract';
import {
  compliancePass,
  consistencyPass,
  dedupeViolations,
  ruleEnginePass,
  sheetHasUsableData,
} from '@/lib/analyze';
import { countCodeChunks } from '@/lib/retrieve';
import { resolveBuildingPart } from '@/lib/occupancy-resolve';
import { emptyAnnotations } from '@/lib/annotations';
import { emptyExtractedSheet, type AnalysisResult, type ExtractedSheet, type FileType, type Violation } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Which extractor handles raster sheets (pdf/image). Only 'vision' (the
// OpenRouter path in lib/extract.ts) ships today.
//
// The Extend provider is parked: its Python function, requirements.txt and
// vercel.json now live under extend/parked/ so Vercel no longer builds a Python
// runtime or runs pip install for a path nothing routes to. The TypeScript
// mapper in lib/extend-extract.ts is still present and still under test
// (npm run test:extend); extend/README.md has the steps to restore it.
const EXTRACT_PROVIDER = (process.env.EXTRACT_PROVIDER ?? 'vision').toLowerCase();

function detectFileType(filename: string): FileType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'dxf') return 'dxf';
  if (ext === 'dwg') return 'dwg';
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'].includes(ext)) return 'image';
  return 'image';
}

function summarize(
  violations: Violation[],
  sheets: ExtractedSheet[],
  planId: string,
  warnings: string[],
): AnalysisResult {
  const summary = { critical: 0, major: 0, minor: 0, compliance: 0, consistency: 0 };
  for (const v of violations) {
    summary[v.severity] += 1;
    summary[v.type] += 1;
  }
  return {
    plan_id: planId,
    violations,
    sheets,
    sheets_analyzed: sheets.length,
    summary,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function POST(req: NextRequest) {
  // eslint-disable-next-line no-console
  console.log('[analyze] request received');
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return NextResponse.json({ error: 'invalid form data', detail: String(err) }, { status: 400 });
  }

  if (EXTRACT_PROVIDER === 'extend') {
    return NextResponse.json(
      {
        error: 'EXTRACT_PROVIDER=extend is not deployable',
        detail:
          'The Extend provider is parked under extend/parked/ and its Python function is not built or deployed. Restore it per extend/README.md, or unset EXTRACT_PROVIDER to use the vision path.',
      },
      { status: 500 },
    );
  }

  const projectName = (formData.get('project_name') as string) || 'Untitled Project';
  const files = formData.getAll('files').filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: 'no files uploaded' }, { status: 400 });
  }

  const { data: planRow, error: planErr } = await supabaseAdmin
    .from('plans')
    .insert({ project_name: projectName, status: 'processing' })
    .select('id')
    .single();

  if (planErr || !planRow) {
    // eslint-disable-next-line no-console
    console.error('[analyze] failed to create plan row', planErr);
    return NextResponse.json(
      {
        error: 'failed to create plan',
        detail: planErr?.message ?? 'unknown',
        code: planErr?.code,
        hint: planErr?.hint,
      },
      { status: 500 },
    );
  }

  const planId = planRow.id as string;
  const sheets: ExtractedSheet[] = [];
  const warnings: string[] = [];
  // eslint-disable-next-line no-console
  console.log(`[analyze] plan ${planId} processing ${files.length} file(s)`);

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    const fileType = detectFileType(file.name);
    // eslint-disable-next-line no-console
    console.log(`[analyze] [${idx + 1}/${files.length}] ${file.name} (${fileType})`);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const storagePath = `${planId}/${Date.now()}-${file.name}`;

    const upload = await supabaseAdmin.storage.from('plans').upload(storagePath, buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
    if (upload.error) {
      // eslint-disable-next-line no-console
      console.error('[analyze] storage upload error', upload.error);
    }

    let extracted: ExtractedSheet;

    try {
      if (fileType === 'pdf') {
        const pdf = await parsePdf(buffer);
        extracted = await extractSheetFromImage({
          sheetName: file.name,
          fileType,
          imageDataUrls: pdf.pageImages,
          textHint: pdf.text,
        });
      } else if (fileType === 'image') {
        const img = await parseImage(buffer, file.name);
        extracted = await extractSheetFromImage({
          sheetName: file.name,
          fileType,
          imageDataUrls: [img.dataUrl],
        });
      } else if (fileType === 'dxf') {
        const dxf = parseDxf(buffer);
        extracted = mergeExtraction(file.name, fileType, {
          dimensions: dxf.dimensions,
          annotations: dxf.annotations,
        });
      } else {
        throw new DwgUnsupportedError();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[analyze] parse failed for ${file.name}`, err);
      const message = err instanceof Error ? err.message : 'parse failed';
      extracted = {
        ...emptyExtractedSheet(file.name, fileType),
        annotations: { ...emptyAnnotations(), other: [`PARSE_ERROR: ${message}`] },
      };
    }

    sheets.push(extracted);

    const flagged = extracted.annotations.other.filter((s) =>
      s.startsWith('PARSE_ERROR') ||
      s.startsWith('VISION_ERROR') ||
      s.startsWith('EXTRACT_EMPTY') ||
      s.startsWith('EXTRACT_UNPARSED') ||
      s.startsWith('EXTEND_ERROR') ||
      s.startsWith('EXTEND_LOW_CONFIDENCE'),
    );
    for (const f of flagged) warnings.push(`${file.name}: ${f}`);

    await supabaseAdmin.from('plan_sheets').insert({
      plan_id: planId,
      sheet_name: file.name,
      file_type: fileType,
      storage_path: storagePath,
      extracted_data: extracted,
    });

    if (idx < files.length - 1 && (fileType === 'pdf' || fileType === 'image')) {
      await delay(1000);
    }
  }

  // eslint-disable-next-line no-console
  console.log('[analyze] running compliance pass');
  const chunkCount = await countCodeChunks();
  if (chunkCount === 0) {
    warnings.push(
      'building_code_chunks table is empty — ingest a code PDF (npm run ingest <pdf>) before compliance can cite sections',
    );
  } else if (chunkCount < 0) {
    warnings.push('could not verify building_code_chunks table — compliance results may be degraded');
  }

  const allViolations: Violation[] = [];
  for (const sheet of sheets) {
    if (!sheetHasUsableData(sheet)) {
      warnings.push(`${sheet.sheet_name}: extraction empty — skipping compliance pass`);
      continue;
    }

    // Resolve which NBC Part governs this sheet once, so the deterministic
    // engine and the LLM pass cannot disagree. The sheet's own text wins; Jev is
    // consulted only when it is silent, and only above a high confidence bar.
    const resolvedPart = await resolveBuildingPart(sheet);
    if (resolvedPart.note) {
      warnings.push(`${sheet.sheet_name}: ${resolvedPart.note}`);
    }

    // Deterministic rule engine first — exact, instant, no model call. Records
    // which sections it covered so the LLM pass below can be deduped against it.
    let coveredSections = new Set<string>();
    try {
      const ruleOut = await ruleEnginePass(sheet, { buildingPart: resolvedPart.part });
      allViolations.push(...ruleOut.violations);
      coveredSections = ruleOut.coveredSections;
      // Say what the guardrails threw away, so "no violations" is never
      // indistinguishable from "nothing was measurable".
      for (const note of ruleOut.skipped.slice(0, 8)) {
        warnings.push(
          `${sheet.sheet_name}: ignored ${note.attribute.replace(/_mm$/, '')} "${note.raw}" on ${
            note.element
          } — ${
            note.reason === 'ambiguous-unit'
              ? 'no unit given and the value is plausible in more than one unit'
              : 'not a physically plausible value for that element'
          }`,
        );
      }
      if (ruleOut.skipped.length > 8) {
        warnings.push(
          `${sheet.sheet_name}: ${ruleOut.skipped.length - 8} further unusable measurement(s) ignored`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`rule engine failed for ${sheet.sheet_name}: ${msg}`);
      // eslint-disable-next-line no-console
      console.error('[analyze] rule engine error', err);
    }

    if (chunkCount === 0) continue;
    try {
      // compliancePass dedupes against the rule engine's sections, tags the
      // survivors as LLM-sourced, and runs them through the TypeSafe (Jev)
      // verification gate before returning.
      const { violations: llmViolations, dropped } = await compliancePass(sheet, {
        coveredSections,
        buildingPart: resolvedPart.part,
      });
      allViolations.push(...llmViolations);

      // A finding the gate removed is reported, never silently dropped.
      for (const d of dropped) {
        warnings.push(
          `${sheet.sheet_name}: discarded unverifiable finding — ${d.violation.description} (${d.verification.verdict}: ${d.verification.note ?? 'no reason given'})`,
        );
      }
      // Surviving findings the gate could not fully stand behind are flagged so
      // a reviewer knows which ones still need a human.
      for (const v of llmViolations) {
        const ver = v.verification;
        if (!ver || ver.verdict === 'verified') continue;
        warnings.push(
          `${sheet.sheet_name}: finding needs review (${ver.verdict}) — ${v.description}${ver.note ? ` [${ver.note}]` : ''}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`compliance pass failed for ${sheet.sheet_name}: ${msg}`);
      // eslint-disable-next-line no-console
      console.error('[analyze] compliance pass error', err);
    }
    await delay(500);
  }

  // eslint-disable-next-line no-console
  console.log('[analyze] running consistency pass');
  try {
    const consistency = await consistencyPass(sheets);
    for (const cv of consistency) cv.source = 'llm';
    allViolations.push(...consistency);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`consistency pass failed: ${msg}`);
    // eslint-disable-next-line no-console
    console.error('[analyze] consistency pass error', err);
  }

  // One physical element measured on several pages must not read as several
  // violations.
  const finalViolations = dedupeViolations(allViolations);

  if (finalViolations.length > 0) {
    const rows = finalViolations.map((v) => ({
      plan_id: planId,
      type: v.type,
      severity: v.severity,
      description: v.description,
      section_id: v.section_id ?? null,
      code_citation: v.code_citation ?? null,
      affected_sheets: v.affected_sheets ?? null,
      location_hint: v.location_hint ?? null,
      source: v.source ?? null,
      verification: v.verification ?? null,
    }));
    const { error: vErr } = await supabaseAdmin.from('violations').insert(rows);
    if (vErr) {
      // eslint-disable-next-line no-console
      console.error('[analyze] violations insert failed', vErr);
    }
  }

  await supabaseAdmin.from('plans').update({ status: 'complete' }).eq('id', planId);

  const result = summarize(finalViolations, sheets, planId, warnings);
  // eslint-disable-next-line no-console
  console.log(`[analyze] done — ${finalViolations.length} violation(s)`);
  return NextResponse.json(result);
}
