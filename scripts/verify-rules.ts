#!/usr/bin/env ts-node
// Verify every transcribed threshold against the real clause text (§6).
//
// §6 requires a human to transcribe thresholds and add unit tests that cite the
// page. This is that test. For each rule it:
//
//   1. resolves every cited clause id in the built store (missing id = fail)
//   2. asserts the rule's threshold appears in the clause text, in the digit
//      grouping the code actually uses ("1 070 mm", not "1070mm")
//   3. reports the printed and pdf page it was found on, and flags a
//      transcribed_from that disagrees
//
// A number in lib/rules/part9.ts that is not in the code fails here rather than
// shipping. A disagreement is a question for the owner, not a thing to patch.

import path from 'path';
import { config as loadEnv } from 'dotenv';
import { loadCodeStore, lookupClauses } from '../lib/code-store';
import { tableText } from '../lib/code-store/tables';
import { PART9_RULES } from '../lib/rules/part9';
import { RuleSchema, type Rule } from '../lib/schemas';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

/**
 * The code prints thousands with a thin space: "1 070 mm", "1 800 mm". A
 * threshold of 1070 must therefore be searched for as "1 070" as well. Metric
 * areas appear as "0.35 m2". Returns every spelling worth looking for.
 */
function spellings(value: number, unit: string): string[] {
  const out = new Set<string>();
  const n = value.toString();
  out.add(n);
  if (Number.isInteger(value) && value >= 1000) {
    // 1070 -> "1 070"
    const s = String(value);
    out.add(`${s.slice(0, s.length - 3)} ${s.slice(-3)}`);
  }
  if (unit === 'm2' || unit === 'm') {
    out.add(n.replace('.', ','));
  }
  // A mm threshold is often written in metres in the prose, and vice versa.
  if (unit === 'mm' && value % 1000 === 0) out.add(String(value / 1000));
  if (unit === 'mm' && value % 100 === 0) out.add((value / 1000).toFixed(1));
  return [...out];
}

interface Result {
  rule: string;
  ok: boolean;
  detail: string;
}

async function main() {
  const store = await loadCodeStore();
  console.log(
    `clause store: ${store.edition} (${store.printing}), ${store.clauses.length} clauses, store_sha256=${store.store_sha256.slice(0, 16)}…\n`,
  );

  const results: Result[] = [];
  const pageNotes: string[] = [];

  for (const rule of PART9_RULES) {
    // The rule file itself must satisfy the schema.
    const shape = RuleSchema.safeParse(rule satisfies Rule);
    if (!shape.success) {
      results.push({
        rule: rule.id,
        ok: false,
        detail: `rule object fails RuleSchema: ${shape.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
      });
      continue;
    }

    // 1. every cited clause must exist
    const missing: string[] = [];
    const found: Awaited<ReturnType<typeof lookupClauses>> = [];
    for (const id of rule.clause_ids) {
      const hits = await lookupClauses(id);
      if (hits.length === 0) missing.push(id);
      else found.push(...hits);
    }
    if (missing.length > 0) {
      results.push({
        rule: rule.id,
        ok: false,
        detail: `clause id(s) not in the store: ${missing.join(', ')}`,
      });
      continue;
    }

    // Five §6 rules read their threshold from a table, not from the sentence
    // prose, so the table text is part of what the threshold is verified
    // against (§5).
    const corpus = found
      .map((c) => [c.text, ...c.tables.map(tableText)].join('\n'))
      .join('\n');
    const pages = [...new Set(found.map((c) => `${c.printed_page || '?'} (pdf ${c.pdf_page})`))];

    // 2. the threshold must appear in that text
    if (rule.test.kind === 'numeric') {
      const checks: Array<{ n: number; label: string }> = [{ n: rule.test.value, label: 'value' }];
      if (rule.test.value_max != null) {
        checks.push({ n: rule.test.value_max, label: 'value_max' });
      }

      const failures: string[] = [];
      for (const { n, label } of checks) {
        const forms = spellings(n, rule.test.unit);
        const hit = forms.find((f) => corpus.includes(f));
        if (!hit) failures.push(`${label}=${n} not found as any of [${forms.join(', ')}]`);
      }

      if (failures.length > 0) {
        results.push({
          rule: rule.id,
          ok: false,
          detail: `${failures.join('; ')} — searched ${rule.clause_ids.join(', ')} on printed p.${pages.join(', ')}`,
        });
        continue;
      }
      results.push({
        rule: rule.id,
        ok: true,
        detail: `${rule.test.value}${rule.test.value_max != null ? `-${rule.test.value_max}` : ''} ${rule.test.unit} confirmed in ${rule.clause_ids[0]}, printed p.${pages[0]}`,
      });
    } else {
      // Presence and judgment rules carry no number to confirm; the clause
      // just has to exist, which step 1 established.
      results.push({
        rule: rule.id,
        ok: true,
        detail: `${rule.test.kind} rule, ${found.length} clause(s) resolved, printed p.${pages.join(', ')}`,
      });
    }

    // 3. transcribed_from should name the page the text actually sits on
    const actualPdf = found[0]?.pdf_page;
    const actualPrinted = found[0]?.printed_page;
    if (actualPdf && Math.abs(actualPdf - rule.transcribed_from.pdf_page) > 1) {
      pageNotes.push(
        `  ${rule.id}: transcribed_from says printed ${rule.transcribed_from.printed_page} / pdf ${rule.transcribed_from.pdf_page}, store has printed ${actualPrinted} / pdf ${actualPdf}`,
      );
    }
  }

  const pass = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);

  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.rule.padEnd(26)} ${r.detail}`);
  }

  if (pageNotes.length > 0) {
    console.log(`\npage citations to correct (${pageNotes.length}):`);
    console.log(pageNotes.join('\n'));
  }

  console.log(`\n${pass.length}/${results.length} rules verified against the code text`);
  if (fail.length > 0) {
    console.log(`${fail.length} FAILED`);
    process.exit(1);
  }
  console.log('ALL PASS');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
