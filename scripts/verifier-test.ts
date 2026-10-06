#!/usr/bin/env ts-node
// S4 verifier test (PLANQ_SPEC.md §S4, §G7).
//
// The Chesnut set produces nothing in a verifiable status, so a live run never
// exercises S4. This drives it directly with the case §7 describes: a rooftop
// guard flagged from a 0.50 m parapet, where a guard may sit on top of the
// parapet without being drawn. The honest verdict is not "upheld".

import path from 'path';
import { config as loadEnv } from 'dotenv';
import { verifyFinding } from '../lib/stages/verify';
import { RunLedger } from '../lib/stages/runner';
import { lookupClauses } from '../lib/code-store';
import { RUN_BUDGET_USD } from '../lib/claude';
import type { Fact, Finding } from '../lib/schemas';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const ledger = new RunLedger(RUN_BUDGET_USD.smallSet);
  const clauses = await lookupClauses('9.8.8.3.');
  if (clauses.length === 0) {
    console.error('code store missing 9.8.8.3.; run npm run code:build');
    process.exit(1);
  }

  const fact: Fact = {
    id: 'f-parapet',
    kind: 'guard_height_mm',
    value: 0.5,
    unit: 'm',
    subject: 'rooftop terrace parapet',
    provenance: 'drawing_text',
    sheet: '02',
    tile: '02-r0c0',
    bbox: [100, 200, 180, 215],
    source_text: 'LEVEL=+6.35 over NPT=+5.85',
    run: 1,
    stable: true,
  };

  const finding: Finding = {
    id: 'F1',
    rule_id: 'guard-height',
    status: 'needs_confirmation',
    summary:
      'Height of guards: rooftop terrace parapet is 500 mm, against a required 1070 mm.',
    clause_ids: ['9.8.8.3.(1)', '9.8.8.3.(2)', '9.8.8.3.(3)'],
    clause_quotes: clauses.slice(0, 3).map((c) => c.text),
    fact_ids: ['f-parapet'],
    computed: { measured: 500, required: '1070 mm', shortfall: 570 },
    evidence_crops: [],
    required_action: 'Raise the guard to at least 1 070 mm.',
    verifier: 'not_run',
    reviewer_state: 'unreviewed',
    drawing_reference: 'Sheet 02, Section A',
  };

  console.log('Verifying F1 (parapet read as a guard, §7 example)\n');
  const res = await verifyFinding({ finding, clauses, facts: [fact] }, ledger);

  console.log(`  verdict:     ${res.finding.verifier}`);
  console.log(`  status:      ${finding.status} -> ${res.finding.status}`);
  console.log(`  downgraded:  ${res.downgraded}`);
  console.log(`  reason:      ${res.finding.verifier_reason}`);
  console.log(`\n  cost: $${ledger.spentUsd.toFixed(4)}`);

  let fail = 0;
  const check = (name: string, cond: boolean) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
    if (!cond) fail++;
  };

  console.log('');
  check('a verdict was returned', ['upheld', 'refuted', 'uncertain'].includes(res.finding.verifier));
  check('a reason for a human was returned', (res.finding.verifier_reason ?? '').length > 20);
  check(
    'anything not upheld was downgraded (§G7)',
    res.finding.verifier === 'upheld' ? !res.downgraded : res.downgraded,
  );
  check(
    'a parapet is not upheld as a guard without confirmation',
    res.finding.verifier !== 'upheld',
  );
  check('usage was recorded for the audit trail (§G10)', ledger.usage.length === 1);
  check('the verifier ran on Opus, not the S3 model', ledger.usage[0]?.model === 'claude-opus-5');

  if (fail > 0) {
    console.log(`\n${fail} FAILED`);
    process.exit(1);
  }
  console.log('\nALL PASS');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
