import { openrouter, MODELS, safeJsonParse } from './openrouter';
import { COMPLIANCE_CATEGORIES, retrieveCodeChunks } from './retrieve';
import type { CodeChunk, ExtractedSheet, Violation } from './types';

const COMPLIANCE_SYSTEM = `You are a building code compliance expert for Canada (NBC 2020 / Alberta Building Code). Given the extracted building plan data and the relevant code sections below, identify all violations. The plan's occupancy classification and building type drive WHICH part of the code applies — Part 9 (Housing & Small Buildings) for single-detached / semi-detached / row houses ≤3 storeys and ≤600 m², Part 3 (Fire Protection / Occupant Safety) for everything else (assembly, business, mercantile, larger residential). Always cite a section consistent with the stated occupancy: do not cite Part 3 thresholds (e.g. 900 mm doors) for a Part 9 dwelling, and do not cite Part 9 thresholds (e.g. 810 mm doors) for a Part 3 building. If occupancy is unstated, mention the ambiguity in the description rather than guessing. Return ONLY a JSON array of violations. Each violation must have: type ('compliance'), severity ('critical'|'major'|'minor'), description, section_id, code_citation, location_hint. Do not include any prose outside the JSON array.`;

const CONSISTENCY_SYSTEM = `You are a building plan reviewer. Compare these extracted sheets from the same project. Identify all inconsistencies — dimensions that conflict between sheets, elements present on one sheet but missing on another, annotation contradictions. Return ONLY a JSON array of violations with: type ('consistency'), severity ('critical'|'major'|'minor'), description, affected_sheets (array of sheet names), location_hint. Do not include any prose outside the JSON array.`;

function formatChunks(chunks: CodeChunk[]): string {
  if (chunks.length === 0) return '(no code sections retrieved)';
  return chunks
    .map((c) => {
      const id = c.section_id ?? 'unknown';
      const title = c.section_title ?? '';
      const body = (c.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
      return `[${id}] ${title}\n${body}`;
    })
    .join('\n\n---\n\n');
}

function normalizeViolations(input: unknown, defaults: Partial<Violation>): Violation[] {
  const arr = Array.isArray(input) ? input : [];
  const violations: Violation[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const type = (r.type as Violation['type']) ?? defaults.type ?? 'compliance';
    const severity = (r.severity as Violation['severity']) ?? 'minor';
    const description = typeof r.description === 'string' ? r.description : '';
    if (!description) continue;
    if (type !== 'compliance' && type !== 'consistency') continue;
    if (severity !== 'critical' && severity !== 'major' && severity !== 'minor') continue;

    violations.push({
      type,
      severity,
      description,
      section_id: typeof r.section_id === 'string' ? r.section_id : undefined,
      code_citation: typeof r.code_citation === 'string' ? r.code_citation : undefined,
      affected_sheets: Array.isArray(r.affected_sheets)
        ? (r.affected_sheets.filter((x) => typeof x === 'string') as string[])
        : defaults.affected_sheets,
      location_hint: typeof r.location_hint === 'string' ? r.location_hint : undefined,
    });
  }
  return violations;
}

export async function compliancePass(sheet: ExtractedSheet): Promise<Violation[]> {
  const allChunks: CodeChunk[] = [];
  const seen = new Set<string>();
  for (const cat of COMPLIANCE_CATEGORIES) {
    const chunks = await retrieveCodeChunks(cat.query, { matchCount: 6, matchThreshold: 0.4 });
    for (const c of chunks) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      allChunks.push(c);
    }
  }

  const codeContext = formatChunks(allChunks);
  const sheetJson = JSON.stringify(sheet, null, 2);

  const occupancyLine =
    sheet.occupancy_type || sheet.building_type
      ? `Stated occupancy/building type: ${[sheet.occupancy_type, sheet.building_type]
          .filter(Boolean)
          .join(' / ')}. Cite sections from the matching NBC Part only.`
      : 'Stated occupancy/building type: NOT SPECIFIED. Treat as ambiguous and note this in any width-threshold violations rather than assuming Part 3 or Part 9.';

  const userContent = `${occupancyLine}\n\nRelevant building code sections:\n${codeContext}\n\nExtracted plan data for sheet "${sheet.sheet_name}":\n${sheetJson}\n\nReturn JSON array of violations only.`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: MODELS.reasoning,
      temperature: 0.1,
      messages: [
        { role: 'system', content: COMPLIANCE_SYSTEM },
        { role: 'user', content: userContent },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content ?? '';
    const parsed = safeJsonParse<unknown>(typeof raw === 'string' ? raw : '', []);
    return normalizeViolations(parsed, { type: 'compliance', affected_sheets: [sheet.sheet_name] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[analyze] compliance pass failed', err);
    return [];
  }
}

export async function consistencyPass(sheets: ExtractedSheet[]): Promise<Violation[]> {
  if (sheets.length < 2) return [];
  const sheetsJson = JSON.stringify(sheets, null, 2);
  const userContent = `Sheets:\n${sheetsJson}\n\nReturn JSON array of consistency violations only.`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: MODELS.reasoning,
      temperature: 0.1,
      messages: [
        { role: 'system', content: CONSISTENCY_SYSTEM },
        { role: 'user', content: userContent },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content ?? '';
    const parsed = safeJsonParse<unknown>(typeof raw === 'string' ? raw : '', []);
    return normalizeViolations(parsed, { type: 'consistency' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[analyze] consistency pass failed', err);
    return [];
  }
}
