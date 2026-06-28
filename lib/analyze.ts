import {
  openrouter,
  REASONING_CHAIN,
  readChoiceText,
  safeJsonParse,
  callWithModelChain,
} from './openrouter';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { COMPLIANCE_CATEGORIES, retrieveCodeChunks } from './retrieve';
import { totalAnnotationCount } from './annotations';
import type { CodeChunk, ExtractedSheet, Violation } from './types';
import { detectBuildingPart } from './rule-engine/occupancy';
import { loadRules } from './rule-engine/loadRules';
import { runRuleEngine, type RuleEngineOutput } from './rule-engine/runner';

export function sheetHasUsableData(sheet: ExtractedSheet): boolean {
  if (
    sheet.rooms.length > 0 ||
    sheet.doors.length > 0 ||
    sheet.corridors.length > 0 ||
    sheet.stairs.length > 0 ||
    sheet.egress_paths.length > 0 ||
    sheet.dimensions.length > 0
  ) {
    return true;
  }
  // Bucketed annotations can carry rescued data even when structured fields
  // are empty — only treat the sheet as truly empty if everything is blank.
  return totalAnnotationCount(sheet.annotations) > 0;
}

const COMPLIANCE_SYSTEM = `You are a building code compliance expert for Canada (NBC 2020 / Alberta Building Code). Given the extracted building plan data and the relevant code sections below, identify all violations.

The plan's occupancy classification and building type drive WHICH part of the code applies — Part 9 (Housing & Small Buildings) for single-detached / semi-detached / row houses ≤3 storeys and ≤600 m², Part 3 (Fire Protection / Occupant Safety) for everything else (assembly, business, mercantile, larger residential). Always cite a section consistent with the stated occupancy. If occupancy is unstated, mention the ambiguity in the description rather than guessing.

CITATION RULES — these are absolute:
1. The "section_id" you emit MUST be a section number that appears somewhere in the provided code excerpts below (either as the chunk label in square brackets, OR mentioned inside the chunk text itself, e.g. "9.9.3.3. Width of Corridors"). The "Allowed section_id values" list further down enumerates the acceptable values — pick the most specific one that the retrieved text actually supports.
2. Do not invent section numbers from memory. If a violation is obvious but no allowed section_id supports it, omit the "section_id" field entirely rather than guessing.
3. Cite the deepest applicable section — prefer "9.9.3.3" over "9.9" when the more specific number appears in the text.
4. The "code_citation" field is a short human label (e.g. "NBC 2020 Part 9, 9.9.3.3 — Width of Corridors"). The section number in it must match section_id.
5. Find every real, observable violation in the plan data. Do not skip clear violations just because their wording is approximate — flag corridors narrower than the stated minimum, doors below the stated minimum, stairs whose run/rise/width is outside the stated range, ceiling heights below the stated minimum, etc.

Return ONLY a JSON array of violations. Each violation must have: type ('compliance'), severity ('critical'|'major'|'minor'), description, section_id (from the allowed list, or omitted), code_citation, location_hint. Do not include any prose outside the JSON array. If you genuinely find no violations, return [].`;

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

function coerceType(raw: unknown, fallback: Violation['type']): Violation['type'] {
  if (typeof raw !== 'string') return fallback;
  const v = raw.toLowerCase();
  if (v.includes('consist')) return 'consistency';
  if (v.includes('compli')) return 'compliance';
  return fallback;
}

function coerceSeverity(raw: unknown): Violation['severity'] {
  if (typeof raw !== 'string') return 'major';
  const v = raw.toLowerCase();
  if (v.includes('crit') || v.includes('high') || v.includes('severe')) return 'critical';
  if (v.includes('min') || v.includes('low')) return 'minor';
  return 'major';
}

function normalizeViolations(input: unknown, defaults: Partial<Violation>): Violation[] {
  const arr = Array.isArray(input) ? input : [];
  const violations: Violation[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    if (!description) continue;

    const type = coerceType(r.type, defaults.type ?? 'compliance');
    const severity = coerceSeverity(r.severity);

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

function detectPartPrefix(sheet: ExtractedSheet): string | undefined {
  // Shared classifier so the LLM retrieval path and the deterministic rule
  // engine agree on Part 9 vs Part 3 (lib/rule-engine/occupancy.ts).
  const part = detectBuildingPart(sheet.occupancy_type, sheet.building_type);
  if (part === 'Part9') return '9.';
  if (part === 'Part3') return '3.';
  return undefined;
}

/**
 * Deterministic compliance pass: load the code_rules table and evaluate the
 * sheet's extracted measurements arithmetically. Runs before the LLM pass; the
 * returned coveredSections let the caller dedupe LLM output. Never throws —
 * an empty/unpopulated rules table just yields no violations.
 */
export async function ruleEnginePass(sheet: ExtractedSheet): Promise<RuleEngineOutput> {
  if (!sheetHasUsableData(sheet)) return { violations: [], coveredSections: new Set() };
  const rules = await loadRules();
  if (rules.length === 0) return { violations: [], coveredSections: new Set() };
  return runRuleEngine(sheet, rules);
}

export async function compliancePass(sheet: ExtractedSheet): Promise<Violation[]> {
  // planq.md: skip compliance entirely when the sheet carries no usable data,
  // otherwise the model will hallucinate violations against an empty plan.
  if (!sheetHasUsableData(sheet)) return [];

  const partPrefix = detectPartPrefix(sheet);
  const partHint =
    partPrefix === '9.'
      ? 'Part 9 housing dwelling unit small building '
      : partPrefix === '3.'
        ? 'Part 3 fire protection major occupancy '
        : '';
  const allChunks: CodeChunk[] = [];
  const seen = new Set<string>();
  for (const cat of COMPLIANCE_CATEGORIES) {
    const chunks = await retrieveCodeChunks(`${partHint}${cat.query}`, {
      matchCount: 8,
      matchThreshold: 0.3,
      partPrefix,
    });
    for (const c of chunks) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      allChunks.push(c);
    }
  }

  // No code context at all means we cannot cite anything credibly. Bail out
  // rather than letting the model invent section numbers.
  if (allChunks.length === 0) {
    throw new Error(
      'no building code chunks available — run `npm run ingest <code.pdf>` to populate the corpus',
    );
  }

  const codeContext = formatChunks(allChunks);
  const sheetJson = JSON.stringify(sheet, null, 2);

  // Build the allowlist of citations. The chunker mislabels many chunks
  // (chunk.section_id points to the preceding heading while the body is
  // text from a different section), so also harvest any "N.N.N(.N)?"
  // pattern that appears INSIDE the retrieved content — these are real
  // citations the model can see and quote.
  const SECTION_RE = /\b\d+\.\d+(?:\.\d+){0,3}\b/g;
  const allowedSet = new Set<string>();
  for (const c of allChunks) {
    if (c.section_id) allowedSet.add(c.section_id.split('#')[0]);
    if (c.content) {
      const matches = c.content.match(SECTION_RE);
      if (matches) for (const m of matches) allowedSet.add(m);
    }
  }
  const allowedIds = Array.from(allowedSet);

  const occupancyLine =
    sheet.occupancy_type || sheet.building_type
      ? `Stated occupancy/building type: ${[sheet.occupancy_type, sheet.building_type]
          .filter(Boolean)
          .join(' / ')}. Cite sections from the matching NBC Part only.`
      : 'Stated occupancy/building type: NOT SPECIFIED. Treat as ambiguous and note this in any width-threshold violations rather than assuming Part 3 or Part 9.';

  const userContent = `${occupancyLine}\n\nAllowed section_id values (cite ONLY these, otherwise omit section_id):\n${allowedIds.join(', ')}\n\nRelevant building code sections:\n${codeContext}\n\nExtracted plan data for sheet "${sheet.sheet_name}":\n${sheetJson}\n\nYour ENTIRE response must be a single valid JSON array, starting with "[" on the very first character. Do not write any preamble, analysis, or "let's think about" text — go directly to the JSON.`;

  try {
    const completion = await callWithModelChain<ChatCompletion>(
      REASONING_CHAIN,
      (model) =>
        openrouter.chat.completions.create({
          model,
          temperature: 0.1,
          max_tokens: 8000,
          messages: [
            { role: 'system', content: COMPLIANCE_SYSTEM },
            { role: 'user', content: userContent },
          ],
          ...({ reasoning: { exclude: true } } as Record<string, unknown>),
        }) as Promise<ChatCompletion>,
      (out) => {
        const text = readChoiceText(out.choices?.[0]?.message as never);
        return text.includes('[');
      },
      (info) => {
        if (process.env.PLANQ_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`[analyze] compliance try ${info.model}: ${info.reason}`);
        }
      },
    );

    if (!completion) {
      // eslint-disable-next-line no-console
      console.error('[analyze] all reasoning models failed for compliance pass');
      return [];
    }

    const raw = readChoiceText(completion.choices?.[0]?.message as never);
    if (process.env.PLANQ_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `[analyze] raw len=${raw.length} finish=${completion.choices?.[0]?.finish_reason} usage=${JSON.stringify(completion.usage ?? {})}\n${raw.slice(0, 2000)}`,
      );
    }
    const parsed = safeJsonParse<unknown>(raw, []);
    const violations = normalizeViolations(parsed, {
      type: 'compliance',
      affected_sheets: [sheet.sheet_name],
    });
    if (process.env.PLANQ_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[analyze] parsed array? ${Array.isArray(parsed)}  normalized: ${violations.length}`);
    }

    // Hallucination guard: only keep section_ids that appeared in the
    // retrieved context. Strip the citation rather than dropping the
    // violation outright — the *observation* may still be valid.
    return violations.map((v) => {
      if (!v.section_id) return v;
      const root = v.section_id.split('#')[0];
      if (allowedSet.has(root)) return v;
      // Also allow shorter prefixes (e.g. model cites 9.9.3.3 when content
      // contains 9.9.3.3.(1)).
      for (const allowed of allowedSet) {
        if (allowed.startsWith(root + '.') || root.startsWith(allowed + '.')) return v;
      }
      // eslint-disable-next-line no-console
      console.warn(`[analyze] stripping invented citation ${v.section_id}`);
      return { ...v, section_id: undefined, code_citation: undefined };
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[analyze] compliance pass failed', err);
    throw err;
  }
}

export async function consistencyPass(sheets: ExtractedSheet[]): Promise<Violation[]> {
  if (sheets.length < 2) return [];
  const sheetsJson = JSON.stringify(sheets, null, 2);
  const userContent = `Sheets:\n${sheetsJson}\n\nYour ENTIRE response must be a single valid JSON array, starting with "[" on the very first character. No preamble or analysis text.`;

  const completion = await callWithModelChain<ChatCompletion>(
    REASONING_CHAIN,
    (model) =>
      openrouter.chat.completions.create({
        model,
        temperature: 0.1,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: CONSISTENCY_SYSTEM },
          { role: 'user', content: userContent },
        ],
        ...({ reasoning: { exclude: true } } as Record<string, unknown>),
      }) as Promise<ChatCompletion>,
    (out) => {
      const text = readChoiceText(out.choices?.[0]?.message as never);
      return text.includes('[');
    },
    (info) => {
      if (process.env.PLANQ_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`[analyze] consistency try ${info.model}: ${info.reason}`);
      }
    },
  );

  if (!completion) {
    // eslint-disable-next-line no-console
    console.error('[analyze] all reasoning models failed for consistency pass');
    return [];
  }

  const raw = readChoiceText(completion.choices?.[0]?.message as never);
  const parsed = safeJsonParse<unknown>(raw, []);
  return normalizeViolations(parsed, { type: 'consistency' });
}
