// The review pipeline, in one place (PLANQ_SPEC.md §4).
//
// S0 intake -> S1 applicability -> S2 extraction -> S3 rules -> S4 verify.
//
// Each stage is a function that takes plain data and returns plain data, so it
// can run in-process (the CLI's runReview below) or as a durable workflow step
// (workflows/review.ts), one sheet or one finding per step. Both callers use
// these same functions. They used to be separate implementations, which is how
// the API route ended up on the retired ExtractedSheet model and still calling
// OpenRouter long after the clause store and rule engine had replaced it.
//
// Why steps at all: a 26-sheet set cannot be read and verified inside one
// 300 s serverless function. Run in one request it either returned a 504 or
// skipped sheets and verification, which is not a defensible review. As steps,
// every sheet is read and every proposed failure is checked, each inside its
// own time limit, and a rate-limited call retries instead of losing a sheet.

import path from 'path';
import { randomUUID } from 'crypto';

import { intake, intakeImage, type IntakeResult, type SheetInventory } from './intake/sheets';
import { readConventions, type Conventions } from './intake/legend';
import { extractNativeFacts } from './intake/native-facts';
import { renderImageSheet, renderSheet, type RenderedSheet } from './intake/render';
import { extractSheetByVision } from './stages/vision';
import { determineApplicability } from './stages/applicability';
import { verifyFinding, verifyFindings } from './stages/verify';
import { RunLedger, BudgetExceededError } from './stages/runner';
import { evaluate, attachClauseQuotes, resetFindingIds } from './engine/evaluate';
import { PART9_RULES } from './rules/part9';
import { loadCodeStore, lookupClauses, quoteIsGrounded } from './code-store';
import { RUN_BUDGET_USD } from './claude';
import { downgrade, VERIFIABLE_STATUSES } from './schemas';
import type {
  Applicability,
  ClauseRecord,
  Fact,
  Finding,
  FindingStatus,
  NegativeEvidence,
  RunAudit,
  StageUsage,
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
  /**
   * Wall-clock time (epoch ms) by which an in-process review must return. Only
   * the CLI uses it now; the web app runs reviews as a workflow with no
   * overall deadline.
   */
  deadline?: number;
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which sheets to read first. Floor plans, sections and schedules carry most of
 * what the rules need; an index or a cover sheet carries none of it. Ties keep
 * the set's own order. Every sheet is still read; this decides the order, and
 * what an in-process run drops first when it runs out of time.
 */
export function sheetPriority(s: { title: string }): number {
  const t = s.title.toUpperCase();
  if (/FLOOR PLAN|MAIN FLOOR|UPPER FLOOR|SECOND FLOOR|BASEMENT|GROUND FLOOR|LOWER FLOOR/.test(t)) return 0;
  if (/SECTION|SCHEDULE|STAIR/.test(t)) return 1;
  if (/ELEVATION|FOUNDATION|DECK/.test(t)) return 2;
  if (/INDEX|COVER|TITLE|LEGEND|KEY PLAN/.test(t)) return 4;
  return 3;
}

/** In-process only: leave this long after S2 for S3, S4 and saving. */
const S2_START_CUTOFF_MS = 150_000;
const S4_START_CUTOFF_MS = 70_000;
/** Two vision calls per sheet, so this fills the runner's 16 call slots. */
export const SHEET_CONCURRENCY = 8;
export const VERIFY_CONCURRENCY = 4;

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
function dedupeAcrossSources(all: Fact[], native: Fact[]): Fact[] {
  const nativeIds = new Set(native.map((f) => f.id));
  const covered = new Set(
    native.map((f) => `${f.kind}|${f.provenance === 'drawing_text' ? f.sheet : 'ifc'}`),
  );
  return all.filter((f) => {
    if (nativeIds.has(f.id)) return true;
    return !covered.has(`${f.kind}|${f.provenance === 'drawing_text' ? f.sheet : 'ifc'}`);
  });
}

async function renderOne(filePath: string, kind: InputKind, sheet: SheetInventory): Promise<RenderedSheet> {
  return kind === 'pdf'
    ? renderSheet(filePath, sheet.pdf_page, sheet.number, sheet.size_pt)
    : renderImageSheet(filePath, sheet.number);
}

// ---------------------------------------------------------------------------
// S0 + S1
// ---------------------------------------------------------------------------

export interface PreparedReview {
  run_id: string;
  started_at: string;
  name: string;
  file_sha256: string;
  sheets: SheetInventory[];
  conventions: Conventions;
  warnings: string[];
  /** Set when S1 or the inputs stop the run before S2. */
  stopped_reason: string | null;
  applicability: Applicability | null;
  predicates: Record<string, boolean | undefined>;
  /** Values read straight from the text layer, with no model call. */
  native_facts: Fact[];
  usage: StageUsage[];
  code_edition: string;
  code_store_hash: string;
}

export async function prepareReview(input: {
  filePath: string;
  kind: InputKind;
  name: string;
  useVision: boolean;
  budgetUsd: number;
  runId?: string;
}): Promise<PreparedReview> {
  const store = await loadCodeStore();
  const ledger = new RunLedger(input.budgetUsd);
  const run_id = input.runId ?? randomUUID().slice(0, 8);

  const intakeResult: IntakeResult =
    input.kind === 'pdf' ? await intake(input.filePath) : await intakeImage(input.filePath, input.name);
  const conventions = readConventions(intakeResult.sheets);
  const warnings = [...intakeResult.warnings];

  const base = {
    run_id,
    started_at: new Date().toISOString(),
    name: input.name,
    file_sha256: intakeResult.file_sha256,
    sheets: intakeResult.sheets,
    conventions,
    warnings,
    code_edition: store.edition,
    code_store_hash: store.store_sha256,
    native_facts: extractNativeFacts(intakeResult.sheets).facts,
  };
  const stopped = (reason: string): PreparedReview => ({
    ...base,
    stopped_reason: reason,
    applicability: null,
    predicates: {},
    usage: ledger.usage,
  });

  const part9Scope = (await lookupClauses('1.3.3.3.(1)'))[0]?.text;
  if (!part9Scope) {
    return stopped(
      'the clause store does not contain Division A 1.3.3.3.(1), so which Part governs cannot be established. Rebuild the store with npm run code:build.',
    );
  }
  const necbScope = (await lookupClauses('1.1.1.1.(1)'))[0]?.text;

  // S1 needs images of sheets with no text layer (scans).
  const renders = new Map<string, RenderedSheet>();
  if (input.useVision) {
    for (const sheet of intakeResult.sheets.filter((s) => !s.has_text_layer)) {
      try {
        renders.set(sheet.number, await renderOne(input.filePath, input.kind, sheet));
      } catch (err) {
        warnings.push(`sheet ${sheet.number}: could not be rendered as an image. ${message(err)}`);
      }
    }
  }
  if (intakeResult.sheets.every((s) => !s.has_text_layer && !renders.has(s.number))) {
    return stopped(
      input.useVision
        ? 'none of the sheets has a text layer and none could be rendered as an image, so there is nothing to read the building size and use from'
        : 'none of the sheets has a text layer and the vision pass is off, so there is nothing to read the building size and use from',
    );
  }

  try {
    const s1 = await determineApplicability(intakeResult.sheets, { part9Scope, necbScope }, ledger, renders);
    if (s1.stop) return stopped(s1.stop);
    return {
      ...base,
      stopped_reason: null,
      applicability: s1.applicability,
      predicates: s1.predicates,
      usage: ledger.usage,
    };
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    return stopped(`applicability could not be determined: ${message(err)}`);
  }
}

// ---------------------------------------------------------------------------
// S2, one sheet
// ---------------------------------------------------------------------------

export interface SheetReading {
  sheet: string;
  facts: Fact[];
  negative: NegativeEvidence[];
  usage: StageUsage[];
  /** Set when the vision pass failed for a reason a retry will not fix. */
  error: string | null;
}

export async function readSheet(input: {
  filePath: string;
  kind: InputKind;
  sheet: SheetInventory;
  conventions: Conventions;
  budgetUsd: number;
}): Promise<SheetReading> {
  const ledger = new RunLedger(input.budgetUsd);
  const rendered = await renderOne(input.filePath, input.kind, input.sheet);
  const v = await extractSheetByVision(input.filePath, input.sheet, PART9_RULES, input.conventions, ledger, {
    rendered,
  });
  return { sheet: input.sheet.number, facts: v.facts, negative: v.negative, usage: ledger.usage, error: null };
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

export interface CheckedRules {
  findings: Finding[];
  facts: Fact[];
  warnings: string[];
}

export async function checkRules(input: {
  prepared: PreparedReview;
  readings: SheetReading[];
}): Promise<CheckedRules> {
  const { prepared } = input;
  const warnings: string[] = [];
  // Merged in the set's own order so fact ids and warnings stay stable.
  const order = new Map(prepared.sheets.map((s, i) => [s.number, i]));
  const readings = [...input.readings].sort((a, b) => (order.get(a.sheet) ?? 0) - (order.get(b.sheet) ?? 0));

  let facts: Fact[] = [...prepared.native_facts];
  const negative: NegativeEvidence[] = [];
  for (const r of readings) {
    if (r.error) {
      warnings.push(`sheet ${r.sheet}: the vision pass failed, so only values in the text layer were read. ${r.error}`);
      continue;
    }
    facts.push(...r.facts);
    negative.push(...r.negative);
  }
  facts = dedupeAcrossSources(facts, prepared.native_facts);
  if (facts.length === 0) {
    warnings.push('No value could be read off the drawings at all, so every rule reports that it cannot be determined.');
  }

  resetFindingIds();
  const engine = evaluate({
    rules: PART9_RULES,
    facts,
    negative,
    applicability: prepared.applicability!,
    predicates: prepared.predicates,
  });

  // §G3: the system owns clause text; a model never supplies it.
  const clauseCache = new Map<string, ClauseRecord[]>();
  for (const f of engine.findings) {
    for (const cid of f.clause_ids) {
      if (!clauseCache.has(cid)) clauseCache.set(cid, await lookupClauses(cid));
    }
  }
  const findings = attachClauseQuotes(engine.findings, (cid) => clauseCache.get(cid)?.[0]?.text);

  let ungrounded = 0;
  for (const f of findings) {
    const cls = f.clause_ids.flatMap((cid) => clauseCache.get(cid) ?? []);
    for (const q of f.clause_quotes) if (!quoteIsGrounded(q, cls)) ungrounded += 1;
  }
  if (ungrounded > 0) {
    warnings.push(`${ungrounded} clause quote(s) could not be matched against the stored code text and were not trusted.`);
  }

  return { findings, facts, warnings };
}

// ---------------------------------------------------------------------------
// S4, one finding
// ---------------------------------------------------------------------------

export interface FindingCheck {
  finding: Finding;
  downgraded: boolean;
  /** True when the verifier could not run, so the finding was downgraded unchecked. */
  skipped: boolean;
  usage: StageUsage[];
}

export async function verifyOne(input: { finding: Finding; facts: Fact[]; budgetUsd: number }): Promise<FindingCheck> {
  const ledger = new RunLedger(input.budgetUsd);
  const clauses = (await Promise.all(input.finding.clause_ids.map((cid) => lookupClauses(cid)))).flat();
  const byId = new Map(input.facts.map((f) => [f.id, f]));
  const facts = input.finding.fact_ids.map((id) => byId.get(id)).filter((x): x is Fact => Boolean(x));
  const res = await verifyFinding({ finding: input.finding, clauses, facts }, ledger);
  return { finding: res.finding, downgraded: res.downgraded, skipped: false, usage: ledger.usage };
}

/** §G7: a finding nobody could try to refute is not upheld, so it is downgraded. */
export function unverified(finding: Finding, reason: string): FindingCheck {
  return {
    finding: { ...finding, status: downgrade(finding.status), verifier: 'uncertain', verifier_reason: reason },
    downgraded: true,
    skipped: true,
    usage: [],
  };
}

export function needsVerification(f: Finding): boolean {
  return VERIFIABLE_STATUSES.includes(f.status);
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export function assembleResult(input: {
  prepared: PreparedReview;
  checked: CheckedRules | null;
  usage: StageUsage[];
  verification: { checked: number; downgraded: number; skipped: number };
  extraWarnings?: string[];
}): ReviewResult {
  const { prepared, checked } = input;
  const stopped = prepared.stopped_reason != null || checked == null;
  const status: RunAudit['status'] = stopped ? 'needs_manual_review' : 'complete';
  const findings = checked?.findings ?? [];
  return {
    run_id: prepared.run_id,
    stopped_reason: prepared.stopped_reason,
    status,
    applicability: prepared.applicability,
    findings,
    counts: countStatuses(findings),
    sheets: summarizeSheets(prepared.sheets),
    facts: checked?.facts ?? [],
    warnings: [...prepared.warnings, ...(checked?.warnings ?? []), ...(input.extraWarnings ?? [])],
    assumed_conventions: prepared.conventions.assumed,
    declared_conventions: prepared.conventions.declared,
    audit: {
      run_id: prepared.run_id,
      input_file_hashes: { [prepared.name]: prepared.file_sha256 },
      code_edition: prepared.code_edition as RunAudit['code_edition'],
      code_store_hash: prepared.code_store_hash,
      usage: input.usage,
      total_cost_usd: input.usage.reduce((a, u) => a + u.cost_usd, 0),
      status,
      started_at: prepared.started_at,
      finished_at: new Date().toISOString(),
    },
    code_edition: prepared.code_edition,
    code_store_hash: prepared.code_store_hash,
    verification: input.verification,
  };
}

// ---------------------------------------------------------------------------
// In-process composition, for the CLI
// ---------------------------------------------------------------------------

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const useVision = opts.useVision ?? true;
  const useVerify = opts.useVerify ?? true;
  const progress = opts.onProgress ?? (() => {});
  const budget = opts.budgetUsd ?? RUN_BUDGET_USD.permitSet;
  const usage: StageUsage[] = [];
  const spent = () => usage.reduce((a, u) => a + u.cost_usd, 0);
  const remaining = () => Math.max(0, budget - spent());

  progress('S0', 'reading the sheets');
  progress('S1', 'determining which code Part governs');
  const prepared = await prepareReview({ filePath: opts.filePath, kind: opts.kind, name: opts.name, useVision, budgetUsd: budget });
  usage.push(...prepared.usage);
  if (prepared.stopped_reason) {
    return assembleResult({ prepared, checked: null, usage, verification: { checked: 0, downgraded: 0, skipped: 0 } });
  }

  // ---- S2 ----
  progress('S2', 'reading values off the drawings');
  const readings: SheetReading[] = [];
  const extraWarnings: string[] = [];
  if (useVision) {
    const queue = [...prepared.sheets].sort((a, b) => sheetPriority(a) - sheetPriority(b));
    const unread: string[] = [];
    const worker = async () => {
      for (let sheet = queue.shift(); sheet; sheet = queue.shift()) {
        if (opts.deadline && Date.now() > opts.deadline - S2_START_CUTOFF_MS) {
          unread.push(sheet.number);
          continue;
        }
        try {
          const r = await readSheet({ filePath: opts.filePath, kind: opts.kind, sheet, conventions: prepared.conventions, budgetUsd: remaining() });
          usage.push(...r.usage);
          readings.push(r);
          progress('S2', `sheet ${sheet.number}: ${r.facts.length} value(s), ${r.facts.filter((f) => f.stable).length} read the same way twice`);
        } catch (err) {
          if (err instanceof BudgetExceededError) throw err;
          readings.push({ sheet: sheet.number, facts: [], negative: [], usage: [], error: message(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: SHEET_CONCURRENCY }, worker));
    if (unread.length > 0) {
      extraWarnings.push(
        `Sheets ${unread.join(', ')} were not read: the review ran out of time before they could be started, so only their text layer was used.`,
      );
    }
  }

  // ---- S3 ----
  progress('S3', 'checking the rules');
  const checked = await checkRules({ prepared, readings });

  // ---- S4 ----
  let verification = { checked: 0, downgraded: 0, skipped: 0 };
  if (useVerify) {
    if (opts.deadline && Date.now() > opts.deadline - S4_START_CUTOFF_MS) {
      const results = checked.findings.map((f) =>
        needsVerification(f) ? unverified(f, 'not verified: the review ran out of time before the independent check could run') : null,
      );
      checked.findings = checked.findings.map((f, i) => results[i]?.finding ?? f);
      const n = results.filter(Boolean).length;
      verification = { checked: 0, downgraded: n, skipped: n };
      if (n > 0) extraWarnings.push(`${n} finding(s) could not be independently checked in time and were downgraded one level.`);
    } else {
      progress('S4', 'trying to refute each finding');
      const ledger = new RunLedger(remaining());
      const clauseFor = new Map<string, ClauseRecord[]>();
      for (const f of checked.findings) {
        for (const cid of f.clause_ids) if (!clauseFor.has(cid)) clauseFor.set(cid, await lookupClauses(cid));
      }
      const factById = new Map(checked.facts.map((f) => [f.id, f]));
      const res = await verifyFindings(
        checked.findings,
        (f) => ({
          clauses: f.clause_ids.flatMap((cid) => clauseFor.get(cid) ?? []),
          facts: f.fact_ids.map((id) => factById.get(id)).filter((x): x is Fact => Boolean(x)),
        }),
        ledger,
      );
      usage.push(...ledger.usage);
      checked.findings = res.findings;
      verification = { checked: res.verified, downgraded: res.downgraded, skipped: res.skipped };
    }
  }

  return assembleResult({ prepared, checked, usage, verification, extraWarnings });
}

export function detectInputKind(filename: string): InputKind | null {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'].includes(ext)) return 'image';
  return null;
}
