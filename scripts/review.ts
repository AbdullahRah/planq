#!/usr/bin/env ts-node
// The full review pipeline (PLANQ_SPEC.md §4).
//
//   npm run review data/Two-story-house-with-dining-room-in-back.pdf
//   npm run review -- --no-vision <pdf>     native text only, no model calls
//   npm run review -- --no-verify <pdf>     skip S4, for a cheaper dry run
//   npm run review -- --out report.md <pdf> write the S5 report
//
// S0 intake, S1 applicability, S2 extraction (native plus vision), S3 rules,
// S4 adversarial verification, S5 report. Every stage's usage is logged and the
// run stops if it exceeds its budget (§G10, §G11).

import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';

import { intake } from '../lib/intake/sheets';
import { readConventions } from '../lib/intake/legend';
import { extractNativeFacts } from '../lib/intake/native-facts';
import { extractSheetByVision } from '../lib/stages/vision';
import { determineApplicability } from '../lib/stages/applicability';
import { verifyFindings } from '../lib/stages/verify';
import { buildReport } from '../lib/stages/report';
import { RunLedger, BudgetExceededError, StageFailedError } from '../lib/stages/runner';
import { evaluate, attachClauseQuotes, resetFindingIds } from '../lib/engine/evaluate';
import { PART9_RULES } from '../lib/rules/part9';
import { loadCodeStore, lookupClauses, quoteIsGrounded } from '../lib/code-store';
import { RUN_BUDGET_USD } from '../lib/claude';
import type { ClauseRecord, Fact, NegativeEvidence, RunAudit } from '../lib/schemas';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

const STATUS_ORDER = ['fail', 'drawing_conflict', 'needs_confirmation', 'cant_determine', 'pass'];

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = process.argv.slice(2).find((a) => a.endsWith('.pdf'));
  if (!file) {
    console.error('usage: npm run review <drawing.pdf> [--no-vision] [--no-verify] [--out report.md]');
    process.exit(1);
  }

  const useVision = !flag('no-vision');
  const useVerify = !flag('no-verify');
  const outPath = opt('out');
  const runId = randomUUID().slice(0, 8);

  const store = await loadCodeStore();
  const ledger = new RunLedger(RUN_BUDGET_USD.permitSet);

  console.log(`Planq review  ${path.basename(file)}   run ${runId}`);
  console.log(`Code: ${store.edition} (${store.printing}), store ${store.store_sha256.slice(0, 12)}\n`);

  // ---- S0 ---------------------------------------------------------------
  const intakeResult = await intake(path.resolve(process.cwd(), file));
  console.log(`S0 intake: ${intakeResult.sheets.length} sheet(s), file ${intakeResult.file_sha256.slice(0, 12)}`);
  for (const s of intakeResult.sheets) {
    console.log(
      `   sheet ${s.number}  "${s.title}"  ${s.scale_statement ?? 'no scale stated'}  ${s.units}  ${s.text_items.length} text items`,
    );
  }
  for (const w of intakeResult.warnings) console.log(`   ! ${w}`);

  const conventions = readConventions(intakeResult.sheets);
  console.log(
    `\nNotation: ${conventions.declared.length} convention(s) declared by the sheets, ${conventions.assumed.length} assumed`,
  );
  for (const d of conventions.declared) console.log(`   declared: ${d}`);

  // ---- S1 ---------------------------------------------------------------
  const part9Scope = (await lookupClauses('1.3.3.3.(1)'))[0]?.text;
  if (!part9Scope) {
    console.error('code store has no Division A 1.3.3.3.(1); cannot determine applicability');
    process.exit(1);
  }
  const necbScope = (await lookupClauses('1.1.1.1.(1)'))[0]?.text;

  const s1 = await determineApplicability(
    intakeResult.sheets,
    { part9Scope, necbScope },
    ledger,
  ).catch((err) => {
    console.error(`\nS1 failed: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  if (!s1) {
    console.log('Run status: needs_manual_review');
    return;
  }
  const app = s1.applicability;
  const predicates = s1.predicates;

  console.log(
    `\nS1 applicability: Part ${app.code_parts.join(', ')}, ${app.energy_path === 'NBC_9.36' ? 'Section 9.36' : 'NECB 2020'}, ${app.storeys} storeys, building area ${app.building_area_m2} m2  (confidence ${app.confidence.toFixed(2)})`,
  );
  for (const [k, v] of Object.entries(app.basis)) console.log(`   ${k}: ${v}`);
  if (s1.stop) {
    console.log(`\nS1 STOP: ${s1.stop}`);
    console.log('Run status: needs_manual_review');
    return;
  }

  // ---- S2 ---------------------------------------------------------------
  const native = extractNativeFacts(intakeResult.sheets);
  const facts: Fact[] = [...native.facts];
  const negative: NegativeEvidence[] = [];
  console.log(`\nS2 native text: ${native.facts.length} fact(s) from the text layer`);

  if (useVision) {
    for (const sheet of intakeResult.sheets) {
      try {
        const v = await extractSheetByVision(
          path.resolve(process.cwd(), file),
          sheet,
          PART9_RULES,
          conventions,
          ledger,
        );
        const stable = v.facts.filter((f) => f.stable).length;
        console.log(
          `S2 vision sheet ${sheet.number}: ${v.facts.length} fact(s), ${stable} stable across both runs; runs read ${v.runCounts[0]}/${v.runCounts[1]}`,
        );
        for (const n of v.notes) console.log(`   note: ${n}`);
        facts.push(...v.facts);
        negative.push(...v.negative);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        console.log(
          `S2 vision sheet ${sheet.number} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } else {
    console.log('S2 vision: skipped (--no-vision)');
  }

  // The native reader and the vision pass both see the whole sheet, so the same
  // printed value arrives twice and one physical element becomes two findings.
  //
  // Deduping on kind + value + unit was wrong: seven different 800 mm doors
  // share all three and collapsed into one, losing six real elements. Identity
  // is the element, not the number, and the two sources word their subjects
  // differently ("P2 door at closet" against "interior door, closet"), so the
  // subject cannot join them either.
  //
  // So dedupe by source precedence instead, per fact kind per sheet: where the
  // text layer produced readings of a kind, the vision readings of that same
  // kind on that sheet are redundant. Native wins because it is the characters
  // themselves rather than a reading of them.
  const nativeCoverage = new Set(
    native.facts.map((f) => `${f.kind}|${f.provenance === 'drawing_text' ? f.sheet : 'ifc'}`),
  );
  const beforeDedupe = facts.length;
  const kept = facts.filter((f) => {
    const isNative = native.facts.some((n) => n.id === f.id);
    if (isNative) return true;
    return !nativeCoverage.has(`${f.kind}|${f.provenance === 'drawing_text' ? f.sheet : 'ifc'}`);
  });
  const dropped = beforeDedupe - kept.length;
  facts.length = 0;
  facts.push(...kept);
  if (dropped > 0) {
    console.log(
      `\nDropped ${dropped} vision fact(s) for kinds the text layer already read verbatim on the same sheet`,
    );
  }

  console.log(`\nFacts in play: ${facts.length}`);
  for (const f of facts) {
    console.log(
      `   ${f.stable ? ' ' : '~'} ${f.kind.padEnd(30)} ${String(f.value).padStart(7)} ${(f.unit ?? '').padEnd(5)} ${f.subject}`,
    );
    console.log(`     "${f.source_text}"`);
  }

  // ---- S3 ---------------------------------------------------------------
  resetFindingIds();
  const out = evaluate({ rules: PART9_RULES, facts, negative, applicability: app, predicates });

  // §G3: the system fetches clause text; the model never supplies it.
  const clauseCache = new Map<string, ClauseRecord[]>();
  for (const f of out.findings) {
    for (const cid of f.clause_ids) {
      if (!clauseCache.has(cid)) clauseCache.set(cid, await lookupClauses(cid));
    }
  }
  let findings = attachClauseQuotes(out.findings, (cid) => clauseCache.get(cid)?.[0]?.text);

  let ungrounded = 0;
  for (const f of findings) {
    for (const q of f.clause_quotes) {
      const cls = f.clause_ids.flatMap((cid) => clauseCache.get(cid) ?? []);
      if (!quoteIsGrounded(q, cls)) ungrounded += 1;
    }
  }

  console.log(`\nS3 findings: ${findings.length}   G3 ungrounded quotes: ${ungrounded} (must be 0)`);

  // ---- S4 ---------------------------------------------------------------
  if (useVerify) {
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
    console.log(
      `S4 verifier: ${res.verified} checked, ${res.downgraded} downgraded, ${res.skipped} could not be verified`,
    );
  } else {
    console.log('S4 verifier: skipped (--no-verify)');
  }

  // ---- summary ----------------------------------------------------------
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
  console.log(`\n   ${STATUS_ORDER.map((s) => `${s} ${counts.get(s) ?? 0}`).join('   ')}`);

  const sorted = [...findings].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  for (const f of sorted) {
    if (f.status === 'pass') continue;
    console.log(`\n${f.id.padEnd(4)} ${f.status.toUpperCase().padEnd(19)} ${f.rule_id}`);
    console.log(`     ${f.summary}`);
    console.log(`     clause ${f.clause_ids.join(', ')}${f.drawing_reference ? `   ${f.drawing_reference}` : ''}`);
    if (f.verifier !== 'not_run') console.log(`     verifier: ${f.verifier}, ${f.verifier_reason}`);
  }

  // ---- G10 audit trail --------------------------------------------------
  const audit: RunAudit = {
    run_id: runId,
    input_file_hashes: { [path.basename(file)]: intakeResult.file_sha256 },
    code_edition: store.edition as RunAudit['code_edition'],
    code_store_hash: store.store_sha256,
    usage: ledger.usage,
    total_cost_usd: ledger.spentUsd,
    status: 'complete',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };

  console.log(
    `\nG10 usage: ${ledger.usage.length} model call(s), $${ledger.spentUsd.toFixed(4)} of a $${RUN_BUDGET_USD.permitSet} budget`,
  );
  for (const u of ledger.usage) {
    console.log(
      `   ${u.stage.padEnd(22)} ${u.model.padEnd(18)} in ${String(u.input_tokens).padStart(7)} out ${String(u.output_tokens).padStart(6)} cache ${String(u.cache_read_input_tokens).padStart(7)} $${u.cost_usd.toFixed(4)}`,
    );
  }

  // ---- S5 ---------------------------------------------------------------
  if (outPath) {
    const md = buildReport({
      projectName: path.basename(file, '.pdf'),
      applicability: app,
      findings,
      rules: PART9_RULES,
      audit,
      intakeWarnings: intakeResult.warnings,
      assumedConventions: conventions.assumed,
      // §G9: nothing is released until a named reviewer approves.
      signOff: null,
    });
    await fs.writeFile(path.resolve(process.cwd(), outPath), md);
    console.log(`\nS5 report written to ${outPath} (unreleased draft, §G9 sign-off pending)`);
  }
}

main().catch((err) => {
  if (err instanceof BudgetExceededError || err instanceof StageFailedError) {
    console.error(`\n${err.message}`);
    console.log('Run status: needs_manual_review');
    process.exit(2);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
