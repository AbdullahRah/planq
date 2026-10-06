#!/usr/bin/env ts-node
// End-to-end review from a drawing PDF (PLANQ_SPEC.md §4).
//
//   npm run review data/Two-story-house-with-dining-room-in-back.pdf
//
// What runs today: S0 intake, native-text extraction, S3 rule engine, and the
// §G3 quote grounding against the clause store. Every verdict here is
// deterministic - no model is called, so this is reproducible and free.
//
// What is still stubbed, and visibly so in the output:
//   S1  applicability is asserted from the sheet text rather than judged by
//       Haiku, so it prints as "asserted" not "determined"
//   S2  the vision pass that reads what the text layer cannot
//   S4  the Opus verifier, so every finding reports verifier: not_run
//   S5  the client report

import path from 'path';
import { config as loadEnv } from 'dotenv';
import { intake, type SheetInventory } from '../lib/intake/sheets';
import { extractNativeFacts } from '../lib/intake/native-facts';
import { evaluate, attachClauseQuotes, resetFindingIds } from '../lib/engine/evaluate';
import { PART9_RULES } from '../lib/rules/part9';
import { loadCodeStore, lookupClauses, quoteIsGrounded } from '../lib/code-store';
import type { Applicability, Finding, NegativeEvidence } from '../lib/schemas';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

/**
 * Storey count and building area off the sheet's own area schedule.
 *
 * Deliberately narrow: it reads the printed "TOTAL M2 OF CONSTRUCTION" style
 * schedule and counts the floor labels. When the sheet does not carry one it
 * returns null and the run stops, because §1.3.3.3.(1) turns on building area
 * and storeys and guessing either decides which Part governs.
 */
function readAreaSchedule(sheets: SheetInventory[]): {
  storeys: number;
  area_m2: number;
  occupancy: string;
  evidence: string;
} | null {
  const all = sheets.flatMap((s) => s.text_items.map((t) => t.text.trim()));
  const joined = all.join(' ');

  // "TOTAL M2 OF CONSTRUCTION:" followed by the figure, possibly a few items later.
  const totalIdx = all.findIndex((t) => /TOTAL\s*M2\s*OF\s*CONSTRUCTION/i.test(t));
  let area_m2: number | null = null;
  if (totalIdx >= 0) {
    for (const t of all.slice(totalIdx + 1, totalIdx + 8)) {
      const m = t.match(/^(\d{2,5}(?:[.,]\d+)?)\s*(?:m2|M2)?$/);
      if (m) {
        area_m2 = Number(m[1].replace(',', '.'));
        break;
      }
    }
  }
  if (area_m2 == null) return null;

  // Storeys from the floor labels the schedule names.
  const labels = ['GROUND FLOOR', 'FIRST LEVEL', 'SECOND LEVEL', 'THIRD LEVEL'];
  const storeys = labels.filter((l) => new RegExp(l, 'i').test(joined)).length;
  if (storeys === 0) return null;

  const residential = /bedroom|dwelling|residence|house/i.test(joined);

  return {
    storeys,
    area_m2,
    occupancy: residential
      ? 'Group C, residential (single dwelling unit)'
      : 'not stated on the sheets',
    evidence: `TOTAL M2 OF CONSTRUCTION = ${area_m2} m2, ${storeys} storey label(s) in the area schedule`,
  };
}

const STATUS_ORDER = ['fail', 'drawing_conflict', 'needs_confirmation', 'cant_determine', 'pass'];

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run review <drawing.pdf>');
    process.exit(1);
  }

  const store = await loadCodeStore();
  console.log(`Planq review  ${path.basename(file)}`);
  console.log(`Code: ${store.edition} (${store.printing}), store ${store.store_sha256.slice(0, 12)}\n`);

  // ---- S0 ---------------------------------------------------------------
  const intakeResult = await intake(path.resolve(process.cwd(), file));
  console.log(`S0 intake: ${intakeResult.sheets.length} sheet(s), file ${intakeResult.file_sha256.slice(0, 12)}`);
  for (const s of intakeResult.sheets) {
    console.log(
      `   sheet ${s.number}  "${s.title}"  ${s.scale_statement ?? 'no scale stated'}  ${s.units}  ${Math.round(s.size_pt.width)}x${Math.round(s.size_pt.height)}pt  ${s.text_items.length} text items`,
    );
  }
  if (intakeResult.warnings.length > 0) {
    console.log('\n   intake warnings:');
    for (const w of intakeResult.warnings) console.log(`   ! ${w}`);
  }

  // ---- S2 (native portion) ----------------------------------------------
  const { facts, levels } = extractNativeFacts(intakeResult.sheets);
  console.log(`\nS2 native extraction: ${facts.length} fact(s), ${levels.length} level mark(s)`);
  for (const f of facts) {
    console.log(
      `   ${f.kind.padEnd(20)} ${String(f.value).padStart(6)} ${(f.unit ?? '').padEnd(5)} ${f.subject}`,
    );
    console.log(`   ${' '.repeat(20)} "${f.source_text}"  sheet ${f.provenance === 'drawing_text' ? f.sheet : 'ifc'}`);
  }

  // ---- S1 (not yet wired to Haiku) --------------------------------------
  // §S1 is explicit that low confidence or conflicting inputs stop the run and
  // ask a human. Until the Haiku stage exists there is no determination at all,
  // so the honest behaviour is to stop rather than to assume.
  //
  // This previously hardcoded the Chesnut values (2 storeys, 134.17 m2) and
  // printed them as "asserted". Running a different set then reported that
  // building as 134.17 m2 with a straight face, which is exactly the failure
  // the §S1 stop exists to prevent.
  const area = readAreaSchedule(intakeResult.sheets);
  if (!area) {
    console.log('\nS1 applicability: CANNOT DETERMINE');
    console.log('   No area schedule or storey count could be read from the sheets, and the');
    console.log('   Haiku applicability stage is not wired yet. §S1 stops the run rather than');
    console.log('   assuming a Part, so no findings are produced.');
    console.log('\nRun status: needs_manual_review');
    return;
  }

  const applicability: Applicability = {
    major_occupancy: area.occupancy,
    storeys: area.storeys,
    building_area_m2: area.area_m2,
    code_parts: ['9'],
    edition: 'NBC(AE) 2023',
    energy_path: 'NBC_9.36',
    confidence: 0.5,
    basis: { code_parts: '1.3.3.3.(1)', energy_path: '9.36.', major_occupancy: '1.4.1.2.' },
    notes: [`read from the sheet area schedule: ${area.evidence}`],
  };
  console.log(
    `\nS1 applicability (READ FROM SHEET, not yet judged by Haiku): Part ${applicability.code_parts.join(', ')}, ${applicability.energy_path}, ${applicability.storeys} storeys, ${applicability.building_area_m2} m2`,
  );
  console.log(`   basis: ${area.evidence}`);

  // Negative evidence for every rule with no supporting fact, so §G5 can
  // report cant_determine with a reason rather than by silence.
  const haveKinds = new Set(facts.map((f) => f.kind));
  const negative: NegativeEvidence[] = PART9_RULES.filter((r) => {
    const needed = r.test.kind === 'numeric' ? [r.test.fact_kind] : r.test.kind === 'presence' ? r.test.fact_kinds : [];
    return needed.length > 0 && !needed.some((k) => haveKinds.has(k));
  }).map((r) => ({
    rule_id: r.id,
    searched_for: ['native text layer', 'schedules', 'general notes'],
    not_found: ['any stated value'],
    sheets_searched: intakeResult.sheets.map((s) => s.number),
  }));

  // ---- S3 ---------------------------------------------------------------
  resetFindingIds();
  const out = evaluate({
    rules: PART9_RULES,
    facts,
    negative,
    applicability,
    predicates: {
      // Asserted alongside S1; these become model or reviewer answers later.
      door_serves_entrance_or_stair: undefined,
      has_storage_garage: true,
      has_garage_or_fuel_appliance: true,
      not_sprinklered: true,
      stair_is_private: true,
    },
  });

  // ---- G3: ground every quote in the store ------------------------------
  const textById = new Map<string, string>();
  for (const f of out.findings) {
    for (const cid of f.clause_ids) {
      if (textById.has(cid)) continue;
      const hits = await lookupClauses(cid);
      if (hits.length > 0) textById.set(cid, hits[0].text);
    }
  }
  const withQuotes = attachClauseQuotes(out.findings, (cid) => textById.get(cid));

  let ungrounded = 0;
  for (const f of withQuotes) {
    for (const q of f.clause_quotes) {
      const clauses = f.clause_ids.flatMap((cid) => {
        const t = textById.get(cid);
        return t ? [{ text: t }] : [];
      });
      if (!quoteIsGrounded(q, clauses as never)) ungrounded += 1;
    }
  }

  // ---- report -----------------------------------------------------------
  const sorted = [...withQuotes].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );

  const counts = new Map<string, number>();
  for (const f of sorted) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);

  console.log(`\nS3 findings: ${sorted.length}`);
  console.log(
    `   ${STATUS_ORDER.map((s) => `${s} ${counts.get(s) ?? 0}`).join('   ')}`,
  );
  console.log(`   judgment rules pending the S2/S3 model pass: ${out.pending_judgment.length}`);
  console.log(`   rules out of scope: ${out.skipped.length}`);
  console.log(`   G3 ungrounded quotes: ${ungrounded} (must be 0)\n`);

  for (const f of sorted) {
    console.log(`${f.id.padEnd(4)} ${f.status.toUpperCase().padEnd(19)} ${f.rule_id}`);
    console.log(`     ${f.summary}`);
    console.log(`     clause ${f.clause_ids.join(', ')}${f.drawing_reference ? `   ${f.drawing_reference}` : ''}`);
    const computed = Object.entries(f.computed)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('  ');
    if (computed) console.log(`     ${computed}`);
    console.log(`     verifier: ${f.verifier}   reviewer: ${f.reviewer_state}`);
    console.log();
  }

  console.log('Not yet run: S1 applicability (Haiku), S2 vision, S4 verifier (Opus), S5 report.');
  console.log('No report may be released until a named reviewer approves it (§G9).');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
