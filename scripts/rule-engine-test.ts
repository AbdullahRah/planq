#!/usr/bin/env ts-node
// Self-contained harness for the deterministic rule engine — no DB, no env.
// Mirrors the repo's runnable "probe" style (there is no jest). Exits non-zero
// on any mismatch. Covers parseToMm + 10 known-violation / 10 known-pass sheets.
import { parseToMm } from '../lib/rule-engine/units';
import { runRuleEngine } from '../lib/rule-engine/runner';
import type { CodeRule } from '../lib/rule-engine/types';
import { emptyExtractedSheet, type ExtractedSheet } from '../lib/types';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- parseToMm ----
console.log('parseToMm:');
const unitCases: Array<[string, number | null]> = [
  ['900mm', 900],
  ['0.9 m', 900],
  ['900', 900],
  ['36"', 914.4],
  ['90cm', 900],
  ["3'-0\"", 914.4],
  ['varies', null],
  ['', null],
];
for (const [input, expected] of unitCases) {
  const got = parseToMm(input);
  const ok =
    expected == null ? got == null : got != null && Math.abs(got - expected) < 0.5;
  check(`parseToMm(${JSON.stringify(input)}) -> ${expected}`, ok, `got ${got}`);
}

// ---- rules (representative Part 9 residential set used in data/nbc-rules.json) ----
const RULES: CodeRule[] = [
  mk('stair', 'run_depth_mm', 'gte', 235, null, 'major', '9.8.4.2', 'Stair run {value}mm is below the {min}mm minimum'),
  mk('stair', 'rise_mm', 'between', 125, 200, 'major', '9.8.4.1', 'Stair rise {value}mm is outside {min}-{max}mm'),
  mk('stair', 'width_mm', 'gte', 860, null, 'major', '9.8.3.1', 'Stair width {value}mm is below {min}mm'),
  mk('door', 'width_mm', 'gte', 810, null, 'major', '9.6.3.1', 'Door width {value}mm is below {min}mm'),
  mk('corridor', 'width_mm', 'gte', 860, null, 'minor', '9.9.3.3', 'Corridor width {value}mm is below {min}mm'),
  mk('room', 'ceiling_height_mm', 'gte', 2030, null, 'major', '9.5.3.1', 'Ceiling height {value}mm is below {min}mm'),
  mk('guard', 'height_mm', 'gte', 900, null, 'critical', '9.8.8.3', 'Guard height {value}mm is below {min}mm'),
];

function mk(
  element_type: CodeRule['element_type'],
  attribute: string,
  operator: CodeRule['operator'],
  value: number,
  value_max: number | null,
  severity: CodeRule['severity'],
  section: string,
  message: string,
): CodeRule {
  return {
    id: `test-${section}-${attribute}`,
    section,
    title: null,
    part: '9',
    jurisdiction: 'NBC_Alberta_2019',
    element_type,
    attribute,
    operator,
    value,
    value_max,
    conditions: {},
    severity,
    message,
  };
}

function sheet(name: string, patch: Partial<ExtractedSheet>): ExtractedSheet {
  return { ...emptyExtractedSheet(name, 'pdf'), occupancy_type: 'residential dwelling', ...patch };
}

// ---- 10 known violations ----
const violationSheets: ExtractedSheet[] = [
  sheet('v1', { stairs: [{ location: 'S-1', run: '220mm' }] }), // run too shallow
  sheet('v2', { stairs: [{ location: 'S-2', rise: '210mm' }] }), // rise too tall
  sheet('v3', { stairs: [{ location: 'S-3', rise: '110mm' }] }), // rise too short
  sheet('v4', { stairs: [{ location: 'S-4', width: '800mm' }] }), // stair too narrow
  sheet('v5', { doors: [{ location: 'D-1', width: '750mm' }] }), // door too narrow
  sheet('v6', { doors: [{ location: 'D-2', width: '30"' }] }), // 762mm < 810
  sheet('v7', { corridors: [{ location: 'C-1', width: '0.8 m' }] }), // 800 < 860
  sheet('v8', { dimensions: [{ element: 'ceiling height', value: '1.9', unit: 'm' }] }), // 1900 < 2030
  sheet('v9', { dimensions: [{ element: 'guard height', value: '850', unit: 'mm' }] }), // 850 < 900
  sheet('v10', { stairs: [{ location: 'S-5', run: '200mm', width: '820mm' }] }), // two failures
];

// ---- 10 known passes ----
const passSheets: ExtractedSheet[] = [
  sheet('p1', { stairs: [{ location: 'S-1', run: '255mm' }] }),
  sheet('p2', { stairs: [{ location: 'S-2', rise: '180mm' }] }),
  sheet('p3', { stairs: [{ location: 'S-3', width: '900mm' }] }),
  sheet('p4', { doors: [{ location: 'D-1', width: '900mm' }] }),
  sheet('p5', { doors: [{ location: 'D-2', width: '36"' }] }), // 914mm
  sheet('p6', { corridors: [{ location: 'C-1', width: '1.1 m' }] }),
  sheet('p7', { dimensions: [{ element: 'ceiling height', value: '2.4', unit: 'm' }] }),
  sheet('p8', { dimensions: [{ element: 'guard height', value: '1070', unit: 'mm' }] }),
  sheet('p9', { stairs: [{ location: 'S-5', run: '280mm', rise: '180mm', width: '900mm' }] }),
  sheet('p10', { rooms: [{ name: 'Bedroom', area: '12 m²' }] }), // no checked attribute
];

console.log('\nViolation fixtures (expect >=1 each):');
for (const s of violationSheets) {
  const out = runRuleEngine(s, RULES);
  check(`${s.sheet_name} flagged`, out.violations.length >= 1, `got ${out.violations.length}`);
}

console.log('\nPass fixtures (expect 0 each):');
for (const s of passSheets) {
  const out = runRuleEngine(s, RULES);
  check(`${s.sheet_name} clean`, out.violations.length === 0, `got ${out.violations.length}`);
}

// Implausible extraction noise must NOT generate violations.
console.log('\nImplausible-value fixtures (expect 0 each):');
const noiseSheets: ExtractedSheet[] = [
  sheet('n1', { stairs: [{ location: 'S-x', rise: '2463mm' }] }), // total rise, not a riser
  sheet('n2', { dimensions: [{ element: 'ceiling height', value: '25.4', unit: 'mm' }] }), // 1 inch
  sheet('n3', { doors: [{ location: 'D-x', width: '12mm' }] }), // misparsed
  sheet('n4', { stairs: [{ location: 'S-y', run: '5mm' }] }), // tolerance value, not a run
];
for (const s of noiseSheets) {
  const out = runRuleEngine(s, RULES);
  check(`${s.sheet_name} not flagged (noise)`, out.violations.length === 0, `got ${out.violations.length}`);
}

// v10 should produce exactly two violations (run + width).
const v10 = runRuleEngine(violationSheets[9], RULES);
check('v10 has 2 violations', v10.violations.length === 2, `got ${v10.violations.length}`);
// covered sections feed dedupe.
check('coveredSections populated', v10.coveredSections.size >= 1, `got ${v10.coveredSections.size}`);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
