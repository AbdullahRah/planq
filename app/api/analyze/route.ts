import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';
import { detectInputKind, runReview } from '@/lib/review';
import { BudgetExceededError } from '@/lib/stages/runner';
import { RUN_BUDGET_USD } from '@/lib/claude';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Run a review (PLANQ_SPEC.md §4).
 *
 * The whole pipeline lives in lib/review.ts so this route and the CLI cannot
 * drift. The previous version of this file had its own extraction path built on
 * OpenRouter and the retired ExtractedSheet model, which is why it kept
 * producing three-level severity violations months after the clause store and
 * rule engine replaced that model.
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return NextResponse.json({ error: 'invalid form data', detail: String(err) }, { status: 400 });
  }

  const projectName = (formData.get('project_name') as string) || 'Untitled Project';
  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'no files uploaded' }, { status: 400 });
  }

  // One review covers one drawing set, and a set is one file today: §S0's
  // sheet inventory comes from inside the document. Multiple uploads are
  // reviewed as separate sets rather than silently merged, which would make a
  // cross-sheet conflict between two unrelated buildings look real.
  const file = files[0];
  const extraFiles = files.slice(1).map((f) => f.name);

  const kind = detectInputKind(file.name);
  if (!kind) {
    return NextResponse.json(
      {
        error: 'unsupported file type',
        detail: `${file.name} is not a PDF or a raster image. DWG and IFC are not supported yet.`,
      },
      { status: 400 },
    );
  }

  const { data: planRow, error: planErr } = await supabaseAdmin
    .from('plans')
    .insert({ project_name: projectName, status: 'processing' })
    .select('id')
    .single();

  if (planErr || !planRow) {
    return NextResponse.json(
      { error: 'failed to create plan', detail: planErr?.message ?? 'unknown' },
      { status: 500 },
    );
  }
  const planId = planRow.id as string;

  const buffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `${planId}/${Date.now()}-${file.name}`;
  const upload = await supabaseAdmin.storage.from('plans').upload(storagePath, buffer, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upload.error) {
    // eslint-disable-next-line no-console
    console.error('[analyze] storage upload failed', upload.error);
  }

  // The pipeline reads from disk: pdfjs and sharp both want a file, and a
  // 25-sheet permit set should not be held in memory three times over.
  const tmp = path.join(os.tmpdir(), `planq-${randomUUID()}${path.extname(file.name)}`);
  await fs.writeFile(tmp, buffer);

  try {
    const result = await runReview({
      filePath: tmp,
      kind,
      name: file.name,
      budgetUsd: RUN_BUDGET_USD.permitSet,
      // Finish inside maxDuration with room to save: a review that returns
      // with some sheets unread beats a 504 that returns nothing.
      deadline: startedAt + (maxDuration - 20) * 1000,
      onProgress: (stage, detail) => {
        // eslint-disable-next-line no-console
        console.log(`[analyze] ${stage}: ${detail}`);
      },
    });

    if (extraFiles.length > 0) {
      result.warnings.push(
        `Only ${file.name} was reviewed. ${extraFiles.join(', ')} ${
          extraFiles.length === 1 ? 'was' : 'were'
        } not, because a review covers one drawing set and merging separate files would make a conflict between unrelated buildings look real.`,
      );
    }

    await supabaseAdmin.from('plan_sheets').insert(
      result.sheets.map((s) => ({
        plan_id: planId,
        sheet_name: `${s.number} ${s.title}`,
        file_type: kind,
        storage_path: storagePath,
        extracted_data: {
          sheet: s,
          facts: result.facts.filter(
            (f) => f.provenance === 'drawing_text' && f.sheet === s.number,
          ),
        },
      })),
    );

    if (result.findings.length > 0) {
      const { error: fErr } = await supabaseAdmin.from('findings').insert(
        result.findings.map((f) => ({
          plan_id: planId,
          run_id: result.run_id,
          finding_id: f.id,
          rule_id: f.rule_id,
          status: f.status,
          summary: f.summary,
          clause_ids: f.clause_ids,
          clause_quotes: f.clause_quotes,
          fact_ids: f.fact_ids,
          computed: f.computed,
          required_action: f.required_action,
          verifier: f.verifier,
          verifier_reason: f.verifier_reason ?? null,
          reviewer_state: f.reviewer_state,
          drawing_reference: f.drawing_reference ?? null,
        })),
      );
      if (fErr) {
        // eslint-disable-next-line no-console
        console.error('[analyze] findings insert failed', fErr);
        result.warnings.push(
          'Findings could not be saved, so this review will not appear in the reviewer queue.',
        );
      }
    }

    await supabaseAdmin
      .from('plans')
      .update({
        status: result.status,
        run_id: result.run_id,
        cost_usd: result.audit.total_cost_usd,
        code_store_hash: result.code_store_hash,
      })
      .eq('id', planId);

    return NextResponse.json({ plan_id: planId, ...result });
  } catch (err) {
    await supabaseAdmin
      .from('plans')
      .update({ status: 'needs_manual_review' })
      .eq('id', planId);

    if (err instanceof BudgetExceededError) {
      return NextResponse.json(
        { error: 'run budget exceeded', detail: err.message, plan_id: planId },
        { status: 402 },
      );
    }
    // eslint-disable-next-line no-console
    console.error('[analyze] review failed', err);
    return NextResponse.json(
      {
        error: 'review failed',
        detail: err instanceof Error ? err.message : String(err),
        plan_id: planId,
      },
      { status: 500 },
    );
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
