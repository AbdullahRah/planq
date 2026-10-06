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
 * The distinction that matters here is building area versus total floor area.
 * Division A 1.3.3.3.(1) applies Part 9 below 600 m2 of BUILDING area, which is
 * the footprint - the greatest horizontal area of a storey - not the sum across
 * storeys. The Chesnut schedule prints both: GROUND FLOOR 87.82 m2 and FIRST
 * LEVEL 122.33 m2 per storey, TOTAL M2 OF CONSTRUCTION 268.33 m2 across them.
 * Feeding 268.33 into a 600 m2 test would push a large house out of Part 9 and
 * into Part 3, changing every rule that then runs.
 *
 * Values are matched by position, not by reading order: the schedule prints its
 * label and figure side by side, and the PDF's item order interleaves them with
 * unrelated title-block text.
 */
function readAreaSchedule(sheets: SheetInventory[]): {
  storeys: number;
  /** Footprint, for 1.3.3.3.(1). */
  building_area_m2: number;
  /** Sum across storeys, reported but never compared against the Part 9 limit. */
  total_floor_area_m2: number | null;
  occupancy: string;
  evidence: string;
} | null {
  const AREA_RE = /^(\d{1,5}(?:[.,]\d+)?)\s*m[²2]$/i;

  /** The figure printed on the same line as a label, to its right. */
  const valueFor = (sheet: SheetInventory, labelRe: RegExp): number | null => {
    const label = sheet.text_items.find((t) => labelRe.test(t.text.trim()));
    if (!label) return null;
    const near = sheet.text_items
      .filter(
        (t) =>
          t !== label &&
          Math.abs(t.y - label.y) < 8 &&
          t.x > label.x &&
          t.x - label.x < 260 &&
          AREA_RE.test(t.text.trim()),
      )
      .sort((a, b) => a.x - b.x)[0];
    if (!near) return null;
    return Number(near.text.trim().match(AREA_RE)![1].replace(',', '.'));
  };

  // Per-storey areas. A storey printed as 0.00 m2 is not a storey.
  const STOREY_LABELS: Array<[string, RegExp]> = [
    ['basement', /^BASEMENT\s*:?$/i],
    ['ground floor', /^GROUND\s+FLOOR\s*:?$/i],
    ['first level', /^FIRST\s+LEVEL\s*:?$/i],
    ['second level', /^SECOND\s+LEVEL\s*:?$/i],
    ['third level', /^THIRD\s+LEVEL\s*:?$/i],
  ];

  const storeyAreas: Array<{ name: string; area: number }> = [];
  let total: number | null = null;

  for (const sheet of sheets) {
    for (const [name, re] of STOREY_LABELS) {
      if (storeyAreas.some((s) => s.name === name)) continue;
      const v = valueFor(sheet, re);
      if (v != null) storeyAreas.push({ name, area: v });
    }
    if (total == null) total = valueFor(sheet, /^TOTAL\s*M2\s*OF\s*CONSTRUCTION\s*:?$/i);
  }

  const occupied = storeyAreas.filter((s) => s.area > 0);
  if (occupied.length === 0) return null;

  const building_area_m2 = Math.max(...occupied.map((s) => s.area));
  const joined = sheets.flatMap((s) => s.text_items.map((t) => t.text)).join(' ');
  const residential = /bedroom|dwelling|residence|house/i.test(joined);

  return {
    storeys: occupied.length,
    building_area_m2,
    total_floor_area_m2: total,
    occupancy: residential
      ? 'Group C, residential (single dwelling unit)'
      : 'not stated on the sheets',
    evidence:
      `${occupied.map((s) => `${s.name} ${s.area} m2`).join(', ')}` +
      `; building area (largest storey) ${building_area_m2} m2` +
      (total != null ? `; total floor area ${total} m2, not used for 1.3.3.3.(1)` : ''),
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
    building_area_m2: area.building_area_m2,
    code_parts: ['9'],
    edition: 'NBC(AE) 2023',
    energy_path: 'NBC_9.36',
    confidence: 0.5,
    basis: { code_parts: '1.3.3.3.(1)', energy_path: '9.36.', major_occupancy: '1.4.1.2.' },
    notes: [`read from the sheet area schedule: ${area.evidence}`],
  };
  console.log(
    `\nS1 applicability (READ FROM SHEET, not yet judged by Haiku): Part ${applicability.code_parts.join(', ')}, ${applicability.energy_path}, ${applicability.storeys} storeys, building area ${applicability.building_area_m2} m2`,
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
