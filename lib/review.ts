// The review pipeline, in one place (PLANQ_SPEC.md §4).
//
// Both the CLI (scripts/review.ts) and the API route (app/api/analyze) call
// this. They used to be separate implementations, which is how the route ended
// up still on the retired ExtractedSheet model and still calling OpenRouter
// long after the clause store and rule engine had replaced it.
//
// S0 intake -> S1 applicability -> S2 extraction -> S3 rules -> S4 verify.
// S5 (the report) is a separate call so a caller can render findings without
// building a document.

import path from 'path';
import { randomUUID } from 'crypto';

import { intake, intakeImage, type IntakeResult, type SheetInventory } from './intake/sheets';
import { readConventions, type Conventions } from './intake/legend';
import { extractNativeFacts } from './intake/native-facts';
import { renderImageSheet, renderSheet, type RenderedSheet } from './intake/render';
import { extractSheetByVision } from './stages/vision';
import { determineApplicability } from './stages/applicability';
import { verifyFindings } from './stages/verify';
import { RunLedger, BudgetExceededError } from './stages/runner';
import { evaluate, attachClauseQuotes, resetFindingIds } from './engine/evaluate';
import { PART9_RULES } from './rules/part9';
import { loadCodeStore, lookupClauses, quoteIsGrounded } from './code-store';
import { RUN_BUDGET_USD } from './claude';
import type {
  Applicability,
  ClauseRecord,
  Fact,
  Finding,
  FindingStatus,
  NegativeEvidence,
  RunAudit,
} from './schemas';

export type InputKind = 'pdf' | 'image';

export interface ReviewOptions {
  /** Absolute path to the drawing file. */
  filePath: string;
  kind: InputKind;
  /** Display name, used when a raster sheet has no title block. */
  name: string;
  useVision?: boolean;
  useVerify?: boolean;
  budgetUsd?: number;
  /** Progress for a UI or a terminal. */
  onProgress?: (stage: string, detail: string) => void;
}

export interface SheetSummary {
  number: string;
  title: string;
  scale_statement: string | null;
  not_to_scale: boolean;
  units: string;
  has_text_layer: boolean;
  text_item_count: number;
}

export interface ReviewResult {
  run_id: string;
  /** Set when the run stopped before producing findings. */
  stopped_reason: string | null;
  status: 'complete' | 'needs_manual_review';
  applicability: Applicability | null;
  findings: Finding[];
  counts: Record<FindingStatus, number>;
  sheets: SheetSummary[];
  facts: Fact[];
  warnings: string[];
  /** Conventions assumed rather than read off a legend. */
  assumed_conventions: string[];
  declared_conventions: string[];
  audit: RunAudit;
  code_edition: string;
  code_store_hash: string;
  /** Verifier outcome counts, for the UI. */
  verification: { checked: number; downgraded: number; skipped: number };
}

const EMPTY_COUNTS: Record<FindingStatus, number> = {
  fail: 0,
  drawing_conflict: 0,
  needs_confirmation: 0,
  cant_determine: 0,
  pass: 0,
};

function countStatuses(findings: Finding[]): Record<FindingStatus, number> {
  const counts = { ...EMPTY_COUNTS };
  for (const f of findings) counts[f.status] += 1;
  return counts;
}

function summarizeSheets(sheets: SheetInventory[]): SheetSummary[] {
  return sheets.map((s) => ({
    number: s.number,
    title: s.title,
    scale_statement: s.scale_statement,
    not_to_scale: s.not_to_scale,
    units: s.units,
    has_text_layer: s.has_text_layer,
    text_item_count: s.text_items.length,
  }));
}

/**
 * Drop vision readings for kinds the text layer already read verbatim on the
 * same sheet. Not keyed on the value: seven different 800 mm doors share a
 * kind, value and unit, and keying on those collapsed them into one.
 */
function dedupeAcrossSources(all: Fact[], native: Fact[]): { facts: Fact[]; dropped: number } {
  const nativeIds = new Set(native.map((f) => f.id));
  const covered = new Set(
    native.map((f) => `${f.kind}|${f.provenance === 'drawing_text' ? f.sheet : 'ifc'}`),
  );
  const kept = all.filter((f) => {
    if (nativeIds.has(f.id)) return true;
    return !covered.has(`${f.kind}|${f.provenance === 'drawing_text' ? f.sheet : 'ifc'}`);
  });
  return { facts: kept, dropped: all.length - kept.length };
}

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const useVision = opts.useVision ?? true;
  const useVerify = opts.useVerify ?? true;
  const progress = opts.onProgress ?? (() => {});
  const runId = randomUUID().slice(0, 8);

  const store = await loadCodeStore();
  const ledger = new RunLedger(opts.budgetUsd ?? RUN_BUDGET_USD.permitSet);
  const startedAt = new Date().toISOString();

  const baseAudit = (status: RunAudit['status'], fileHash: string): RunAudit => ({
    run_id: runId,
    input_file_hashes: { [opts.name]: fileHash },
    code_edition: store.edition as RunAudit['code_edition'],
    code_store_hash: store.store_sha256,
    usage: ledger.usage,
    total_cost_usd: ledger.spentUsd,
    status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  // ---- S0 ---------------------------------------------------------------
  progress('S0', 'reading the sheets');
  const intakeResult: IntakeResult =
    opts.kind === 'pdf'
      ? await intake(opts.filePath)
      : await intakeImage(opts.filePath, opts.name);

  const conventions: Conventions = readConventions(intakeResult.sheets);
  const warnings = [...intakeResult.warnings];

  const stopped = (reason: string): ReviewResult => ({
    run_id: runId,
    stopped_reason: reason,
    status: 'needs_manual_review',
    applicability: null,
    findings: [],
    counts: { ...EMPTY_COUNTS },
    sheets: summarizeSheets(intakeResult.sheets),
    facts: [],
    warnings,
    assumed_conventions: conventions.assumed,
    declared_conventions: conventions.declared,
    audit: baseAudit('needs_manual_review', intakeResult.file_sha256),
    code_edition: store.edition,
    code_store_hash: store.store_sha256,
    verification: { checked: 0, downgraded: 0, skipped: 0 },
  });

  // ---- S1 ---------------------------------------------------------------
  progress('S1', 'determining which code Part governs');
  const part9Scope = (await lookupClauses('1.3.3.3.(1)'))[0]?.text;
  if (!part9Scope) {
    return stopped(
      'the clause store does not contain Division A 1.3.3.3.(1), so which Part governs cannot be established. Rebuild the store with npm run code:build.',
    );
  }
  const necbScope = (await lookupClauses('1.1.1.1.(1)'))[0]?.text;

  // Each sheet is rendered once and shared by S1 and S2. S1 needs the images
  // of sheets with no text layer (scans); S2 needs every sheet.
  const renders = new Map<string, RenderedSheet>();
  const render = async (sheet: SheetInventory): Promise<RenderedSheet> => {
    const cached = renders.get(sheet.number);
    if (cached) return cached;
    const r =
      opts.kind === 'pdf'
        ? await renderSheet(opts.filePath, sheet.pdf_page, sheet.number, sheet.size_pt)
        : await renderImageSheet(opts.filePath, sheet.number);
    renders.set(sheet.number, r);
    return r;
  };

  if (useVision) {
    for (const sheet of intakeResult.sheets.filter((s) => !s.has_text_layer)) {
      try {
        await render(sheet);
      } catch (err) {
        warnings.push(
          `sheet ${sheet.number}: could not be rendered as an image. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (intakeResult.sheets.every((s) => !s.has_text_layer && !renders.has(s.number))) {
    return stopped(
      useVision
        ? 'none of the sheets has a text layer and none could be rendered as an image, so there is nothing to read the building size and use from'
        : 'none of the sheets has a text layer and the vision pass is off, so there is nothing to read the building size and use from',
    );
  }

  let applicability: Applicability;
  let predicates: Record<string, boolean | undefined>;
  try {
    const s1 = await determineApplicability(
      intakeResult.sheets,
      { part9Scope, necbScope },
      ledger,
      renders,
    );
    if (s1.stop) return stopped(s1.stop);
    applicability = s1.applicability;
    predicates = s1.predicates;
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    return stopped(
      `applicability could not be determined: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ---- S2 ---------------------------------------------------------------
  progress('S2', 'reading values off the drawings');
  const native = extractNativeFacts(intakeResult.sheets);
  let facts: Fact[] = [...native.facts];
  const negative: NegativeEvidence[] = [];

  if (useVision) {
    // Sheets are read at the same time. One after another, a two-sheet set
    // spent over four minutes here and Vercel cut the function off at 300 s.
    // Results are merged in sheet order so fact ids and warnings stay stable.
    const results = await Promise.all(
      intakeResult.sheets.map(async (sheet) => {
        try {
          const rendered = await render(sheet);
          const v = await extractSheetByVision(
            opts.filePath,
            sheet,
            PART9_RULES,
            conventions,
            ledger,
            { rendered },
          );
          progress(
            'S2',
            `sheet ${sheet.number}: ${v.facts.length} value(s), ${v.facts.filter((f) => f.stable).length} read the same way twice`,
          );
          return { ok: true as const, v };
        } catch (err) {
          return { ok: false as const, sheet, err };
        }
      }),
    );
    for (const r of results) {
      if (r.ok) {
        facts.push(...r.v.facts);
        negative.push(...r.v.negative);
        continue;
      }
      if (r.err instanceof BudgetExceededError) throw r.err;
      warnings.push(
        `sheet ${r.sheet.number}: the vision pass failed, so only values in the text layer were read. ${
          r.err instanceof Error ? r.err.message : String(r.err)
        }`,
      );
    }
  }

  const deduped = dedupeAcrossSources(facts, native.facts);
  facts = deduped.facts;

  if (facts.length === 0) {
    warnings.push(
      'No value could be read off the drawings at all, so every rule reports that it cannot be determined.',
    );
  }

  // ---- S3 ---------------------------------------------------------------
  progress('S3', 'checking the rules');
  resetFindingIds();
  const engine = evaluate({ rules: PART9_RULES, facts, negative, applicability, predicates });

  // §G3: the system owns clause text; a model never supplies it.
  const clauseCache = new Map<string, ClauseRecord[]>();
  for (const f of engine.findings) {
    for (const cid of f.clause_ids) {
      if (!clauseCache.has(cid)) clauseCache.set(cid, await lookupClauses(cid));
    }
  }
  let findings = attachClauseQuotes(engine.findings, (cid) => clauseCache.get(cid)?.[0]?.text);

  let ungrounded = 0;
  for (const f of findings) {
    const cls = f.clause_ids.flatMap((cid) => clauseCache.get(cid) ?? []);
    for (const q of f.clause_quotes) if (!quoteIsGrounded(q, cls)) ungrounded += 1;
  }
  if (ungrounded > 0) {
    warnings.push(
      `${ungrounded} clause quote(s) could not be matched against the stored code text and were not trusted.`,
    );
  }

  // ---- S4 ---------------------------------------------------------------
  let verification = { checked: 0, downgraded: 0, skipped: 0 };
  if (useVerify) {
    progress('S4', 'trying to refute each finding');
    const factById = new Map(facts.map((f) => [f.id, f]));
    const res = await verifyFindings(
      findings,
      (f) => ({
        clauses: f.clause_ids.flatMap((cid) => clauseCache.get(cid) ?? []),
        facts: f.fact_ids.map((id) => factById.get(id)).filter((x): x is Fact => Boolean(x)),
      }),
      ledger,
    );
    findings = res.findings;
    verification = { checked: res.verified, downgraded: res.downgraded, skipped: res.skipped };
  }

  return {
    run_id: runId,
    stopped_reason: null,
    status: 'complete',
    applicability,
    findings,
    counts: countStatuses(findings),
    sheets: summarizeSheets(intakeResult.sheets),
    facts,
    warnings,
    assumed_conventions: conventions.assumed,
    declared_conventions: conventions.declared,
    audit: baseAudit('complete', intakeResult.file_sha256),
    code_edition: store.edition,
    code_store_hash: store.store_sha256,
    verification,
  };
}

export function detectInputKind(filename: string): InputKind | null {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'].includes(ext)) return 'image';
  return null;
}
