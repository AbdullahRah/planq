// A review as a durable workflow (PLANQ_SPEC.md §4, run in the background).
//
// One request cannot hold a review. A 26-sheet set needs about 52 vision calls
// and a verifier call per proposed failure; inside a single 300 s function it
// either returned a 504 or dropped sheets and skipped the independent check.
// Neither is a review anyone can defend. Here each unit of work is a step with
// its own time limit and its own retries:
//
//   prepare   S0 intake + S1 applicability                   one step
//   read      S2 vision, one sheet per step, 8 at a time      every sheet
//   rules     S3 rule engine and clause quotes                one step
//   verify    S4, one finding per step, 4 at a time           every proposed failure
//   save      findings, result and status to Supabase         one step
//
// The workflow function only orchestrates: it runs in a sandbox with no
// Node.js, so all real work, including every model call, lives in steps.
// The pipeline itself is lib/review.ts, shared with the CLI.

import { FatalError, RetryableError } from 'workflow';
import type {
  CheckedRules,
  FindingCheck,
  InputKind,
  PreparedReview,
  ReviewResult,
  SheetReading,
} from '@/lib/review';
import type { Finding, StageUsage } from '@/lib/schemas';

export interface ReviewInput {
  planId: string;
  storagePath: string;
  kind: InputKind;
  name: string;
  budgetUsd: number;
}

export interface ReviewProgress {
  stage: 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'done' | 'failed';
  detail: string;
  done?: number;
  total?: number;
}

const SHEETS_AT_ONCE = 8;
const FINDINGS_AT_ONCE = 4;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const cost = (usage: StageUsage[]) => usage.reduce((a, u) => a + u.cost_usd, 0);

export async function reviewWorkflow(input: ReviewInput): Promise<{ status: string }> {
  'use workflow';

  try {
    await setProgress(input.planId, { stage: 'S1', detail: 'reading the sheets and determining which code Part governs' });
    const prepared = await prepareStep(input);
    const usage: StageUsage[] = [...prepared.usage];

    if (prepared.stopped_reason) {
      await saveStep(input.planId, { prepared, checked: null, usage, verification: { checked: 0, downgraded: 0, skipped: 0 } });
      return { status: 'needs_manual_review' };
    }

    // ---- S2: every sheet, most useful first ----
    const order = await sheetOrderStep(prepared);
    const total = order.length;
    const readings: SheetReading[] = [];
    await setProgress(input.planId, { stage: 'S2', detail: 'reading values off the drawings', done: 0, total });
    for (const batch of chunks(order, SHEETS_AT_ONCE)) {
      const remaining = Math.max(0, input.budgetUsd - cost(usage));
      const settled = await Promise.allSettled(
        // Each step gets its own sheet only, not the whole inventory: step
        // inputs are stored in the run's log, once per step.
        batch.map((sheetNumber) =>
          readSheetStep(input, prepared.sheets.find((s) => s.number === sheetNumber)!, prepared.conventions, remaining),
        ),
      );
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') {
          readings.push(s.value);
          usage.push(...s.value.usage);
        } else {
          // Out of retries. Recorded, never silently dropped: the report says
          // which sheet was read from its text layer only.
          readings.push({ sheet: batch[i], facts: [], negative: [], usage: [], error: String(s.reason?.message ?? s.reason) });
        }
      });
      await setProgress(input.planId, {
        stage: 'S2',
        detail: 'reading values off the drawings',
        done: readings.length,
        total,
      });
    }

    // ---- S3 ----
    await setProgress(input.planId, { stage: 'S3', detail: 'checking the rules' });
    const checked = await rulesStep(prepared, readings);

    // ---- S4: every proposed failure ----
    const toVerify = checked.findings
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.status === 'fail' || f.status === 'needs_confirmation');
    let verification = { checked: 0, downgraded: 0, skipped: 0 };
    if (toVerify.length > 0) {
      await setProgress(input.planId, { stage: 'S4', detail: 'trying to refute each finding', done: 0, total: toVerify.length });
      let done = 0;
      for (const batch of chunks(toVerify, FINDINGS_AT_ONCE)) {
        const remaining = Math.max(0, input.budgetUsd - cost(usage));
        const settled = await Promise.allSettled(
          batch.map(({ f }) => verifyStep(f, checked.facts, remaining)),
        );
        settled.forEach((s, k) => {
          const { i, f } = batch[k];
          const res: FindingCheck =
            s.status === 'fulfilled'
              ? s.value
              : {
                  // §G7: not upheld, so downgraded, and said so.
                  finding: { ...f, status: f.status === 'fail' ? 'needs_confirmation' : 'cant_determine', verifier: 'uncertain', verifier_reason: `verification could not be completed: ${String(s.reason?.message ?? s.reason)}` },
                  downgraded: true,
                  skipped: true,
                  usage: [],
                };
          checked.findings[i] = res.finding;
          usage.push(...res.usage);
          if (res.skipped) verification.skipped += 1;
          else verification.checked += 1;
          if (res.downgraded) verification.downgraded += 1;
        });
        done += batch.length;
        await setProgress(input.planId, { stage: 'S4', detail: 'trying to refute each finding', done, total: toVerify.length });
      }
    }

    await saveStep(input.planId, { prepared, checked, usage, verification });
    return { status: 'complete' };
  } catch (err) {
    await failStep(input.planId, String((err as Error)?.message ?? err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Steps. Full Node.js; each runs inside its own function time limit.
// ---------------------------------------------------------------------------

/** Rate limits and overloads are worth waiting out; a bad request is not. */
function classify(err: unknown): never {
  const e = err as { status?: number; name?: string; message?: string };
  if (e?.name === 'BudgetExceededError') throw new FatalError(e.message ?? 'run budget exceeded');
  if (e?.status === 429 || e?.status === 529) {
    throw new RetryableError(`model API ${e.status === 429 ? 'rate limited' : 'overloaded'}: ${e.message}`, {
      retryAfter: '1m',
    });
  }
  throw err;
}

/**
 * The drawing, on this instance's disk. Steps can run on different instances,
 * so each fetches it from storage once and reuses it after that.
 */
async function localCopy(input: ReviewInput): Promise<string> {
  const { promises: fs } = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const { createHash } = await import('crypto');
  const file = path.join(
    os.tmpdir(),
    `planq-${createHash('sha1').update(input.storagePath).digest('hex').slice(0, 16)}${path.extname(input.name)}`,
  );
  try {
    await fs.access(file);
    return file;
  } catch {
    // not here yet
  }
  const { supabaseAdmin } = await import('@/lib/supabase');
  const { data, error } = await supabaseAdmin.storage.from('plans').download(input.storagePath);
  if (error || !data) throw new Error(`could not fetch the drawing from storage: ${error?.message ?? 'no data'}`);
  await fs.writeFile(file, Buffer.from(await data.arrayBuffer()));
  return file;
}

async function setProgress(planId: string, progress: ReviewProgress): Promise<void> {
  'use step';
  const { supabaseAdmin } = await import('@/lib/supabase');
  await supabaseAdmin.from('plans').update({ progress, updated_at: new Date().toISOString() }).eq('id', planId);
}

async function prepareStep(input: ReviewInput): Promise<PreparedReview> {
  'use step';
  const { prepareReview } = await import('@/lib/review');
  try {
    const filePath = await localCopy(input);
    return await prepareReview({
      filePath,
      kind: input.kind,
      name: input.name,
      useVision: true,
      budgetUsd: input.budgetUsd,
      runId: input.planId.slice(0, 8),
    });
  } catch (err) {
    classify(err);
  }
}

async function sheetOrderStep(prepared: PreparedReview): Promise<string[]> {
  'use step';
  const { sheetPriority } = await import('@/lib/review');
  return [...prepared.sheets].sort((a, b) => sheetPriority(a) - sheetPriority(b)).map((s) => s.number);
}

async function readSheetStep(
  input: ReviewInput,
  sheet: PreparedReview['sheets'][number],
  conventions: PreparedReview['conventions'],
  budgetUsd: number,
): Promise<SheetReading> {
  'use step';
  const { readSheet } = await import('@/lib/review');
  try {
    const filePath = await localCopy(input);
    return await readSheet({ filePath, kind: input.kind, sheet, conventions, budgetUsd });
  } catch (err) {
    classify(err);
  }
}
readSheetStep.maxRetries = 4;

async function rulesStep(prepared: PreparedReview, readings: SheetReading[]): Promise<CheckedRules> {
  'use step';
  const { checkRules } = await import('@/lib/review');
  return checkRules({ prepared, readings });
}

async function verifyStep(finding: Finding, facts: CheckedRules['facts'], budgetUsd: number): Promise<FindingCheck> {
  'use step';
  const { verifyOne } = await import('@/lib/review');
  try {
    return await verifyOne({ finding, facts, budgetUsd });
  } catch (err) {
    classify(err);
  }
}
verifyStep.maxRetries = 4;

async function saveStep(
  planId: string,
  input: {
    prepared: PreparedReview;
    checked: CheckedRules | null;
    usage: StageUsage[];
    verification: { checked: number; downgraded: number; skipped: number };
  },
): Promise<void> {
  'use step';
  const { assembleResult } = await import('@/lib/review');
  const { supabaseAdmin } = await import('@/lib/supabase');
  const result: ReviewResult = assembleResult(input);

  // Idempotent: a retried save replaces this run's rows rather than doubling them.
  await supabaseAdmin.from('findings').delete().eq('plan_id', planId).eq('run_id', result.run_id);
  await supabaseAdmin.from('plan_sheets').delete().eq('plan_id', planId);

  await supabaseAdmin.from('plan_sheets').insert(
    result.sheets.map((s) => ({
      plan_id: planId,
      sheet_name: `${s.number} ${s.title}`,
      file_type: 'pdf',
      extracted_data: {
        sheet: s,
        facts: result.facts.filter((f) => f.provenance === 'drawing_text' && f.sheet === s.number),
      },
    })),
  );

  if (result.findings.length > 0) {
    const { error } = await supabaseAdmin.from('findings').insert(
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
    if (error) throw new Error(`findings insert failed: ${error.message}`);
  }

  const { error: planErr } = await supabaseAdmin
    .from('plans')
    .update({
      status: result.status,
      run_id: result.run_id,
      cost_usd: result.audit.total_cost_usd,
      code_store_hash: result.code_store_hash,
      result,
      progress: { stage: 'done', detail: 'review complete' } satisfies ReviewProgress,
      updated_at: new Date().toISOString(),
    })
    .eq('id', planId);
  if (planErr) throw new Error(`plan update failed: ${planErr.message}`);
}

async function failStep(planId: string, error: string): Promise<void> {
  'use step';
  const { supabaseAdmin } = await import('@/lib/supabase');
  await supabaseAdmin
    .from('plans')
    .update({
      status: 'failed',
      error,
      progress: { stage: 'failed', detail: error } satisfies ReviewProgress,
      updated_at: new Date().toISOString(),
    })
    .eq('id', planId);
}
