#!/usr/bin/env ts-node
// Self-contained harness for the deterministic rule engine — no DB, no env.
// Mirrors the repo's runnable "probe" style (there is no jest). Exits non-zero
// on any mismatch. Covers parseToMm + 10 known-violation / 10 known-pass sheets.
import { parseDimension, parseToMm } from '../lib/rule-engine/units';
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

// ---- unit provenance ----
console.log('\nparseDimension unit provenance:');
check('"900mm" is explicit', parseDimension('900mm')?.explicitUnit === true);
check('"0.9 m" is explicit', parseDimension('0.9 m')?.explicitUnit === true);
check('"900" is unitless', parseDimension('900')?.explicitUnit === false);

// Unitless numbers must be rescued when exactly one unit reading is physically
// possible — this is where "no remarks" came from on plans that label metres.
console.log('\nUnitless-value fixtures:');
const unitlessFlag: Array<[string, ExtractedSheet]> = [
  ['u1 ceiling "2.0" read as metres', sheet('u1', { dimensions: [{ element: 'ceiling height', value: '2.0', unit: '' }] })],
  ['u2 door "0.75" read as metres', sheet('u2', { doors: [{ location: 'D-1', width: '0.75' }] })],
];
for (const [name, s2] of unitlessFlag) {
  const out = runRuleEngine(s2, RULES);
  check(name, out.violations.length === 1, `got ${out.violations.length}`);
}
// "36" is plausible as both centimetres (360mm) and inches (914mm) — refuse it
// rather than guess a violation into existence.
const ambiguous = runRuleEngine(sheet('u3', { doors: [{ location: 'D-2', width: '36' }] }), RULES);
check('u3 ambiguous unit not flagged', ambiguous.violations.length === 0, `got ${ambiguous.violations.length}`);
check('u3 reports why it was skipped', ambiguous.skipped.some((n) => n.reason === 'ambiguous-unit'));

// ---- guardrails against false positives ----
console.log('\nFalse-positive guards (expect 0 each):');
const part3Sheet: ExtractedSheet = {
  ...emptyExtractedSheet('g1', 'pdf'),
  occupancy_type: 'business office',
  building_type: 'high-rise office building',
  doors: [{ location: 'D-1', width: '750mm' }],
};
const g1 = runRuleEngine(part3Sheet, RULES);
check('g1 Part 9 rules do not fire on a Part 3 building', g1.violations.length === 0, `got ${g1.violations.length}`);

const guardSheets: Array<[string, ExtractedSheet]> = [
  ['g2 closet door exempt from doorway width', sheet('g2', { doors: [{ location: 'D-4 closet', width: '700mm' }] })],
  ['g3 wardrobe door exempt', sheet('g3', { doors: [{ location: 'BR-2', type: 'wardrobe', width: '600mm' }] })],
  ['g4 in-suite corridor exempt', sheet('g4', { corridors: [{ location: 'in-suite corridor', width: '800mm' }] })],
  ['g5 "total rise" is not a riser', sheet('g5', { dimensions: [{ element: 'total rise', value: '2463', unit: 'mm' }] })],
];
for (const [name, s2] of guardSheets) {
  const out = runRuleEngine(s2, RULES);
  check(name, out.violations.length === 0, `got ${out.violations.length}`);
}

// A Part 9 building still gets Part 9 checks.
const part9Door = runRuleEngine(sheet('g6', { doors: [{ location: 'D-1', width: '750mm' }] }), RULES);
check('g6 Part 9 door still flagged', part9Door.violations.length === 1, `got ${part9Door.violations.length}`);

// Multi-page extractions merge into one sheet, repeating the same element.
const dupe = runRuleEngine(
  sheet('g7', {
    doors: [
      { location: 'D-1', width: '750mm' },
      { location: 'D-1', width: '750mm' },
      { location: 'D-1', width: '750mm' },
    ],
  }),
  RULES,
);
check('g7 repeated element reported once', dupe.violations.length === 1, `got ${dupe.violations.length}`);

// v10 should produce exactly two violations (run + width).
const v10 = runRuleEngine(violationSheets[9], RULES);
check('v10 has 2 violations', v10.violations.length === 2, `got ${v10.violations.length}`);
// covered sections feed dedupe.
check('coveredSections populated', v10.coveredSections.size >= 1, `got ${v10.coveredSections.size}`);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
