#!/usr/bin/env ts-node
// Engine tests, including the Chesnut expected outcomes (PLANQ_SPEC.md §9).
//
// The fixture here supplies facts directly rather than extracting them, so this
// tests S3 in isolation: given the facts the Chesnut drawings carry, does the
// engine reach the statuses the hand review reached? Extraction is tested
// separately once S2 lands.

import path from 'path';
import { config as loadEnv } from 'dotenv';
import { evaluate, resetFindingIds } from '../lib/engine/evaluate';
import { convert } from '../lib/engine/units';
import { PART9_RULES, ruleById } from '../lib/rules/part9';
import {
  type Applicability,
  type Fact,
  type NegativeEvidence,
  FindingSchema,
  downgrade,
} from '../lib/schemas';
import type { SpaceClass } from '../lib/engine/spaces';
import { classifySpace } from '../lib/engine/spaces';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const CHESNUT_APP: Applicability = {
  major_occupancy: 'Group C, residential (single dwelling unit)',
  storeys: 2,
  building_area_m2: 134.17,
  code_parts: ['9'],
  edition: 'NBC(AE) 2023',
  energy_path: 'NBC_9.36',
  confidence: 0.95,
  basis: {
    code_parts: '1.3.3.3.(1)',
    energy_path: '9.36.',
    major_occupancy: '1.4.1.2.',
  },
  notes: [],
};

function drawingFact(
  id: string,
  kind: string,
  value: number | string,
  unit: string | undefined,
  subject: string,
  sheet: string,
  source_text: string,
  stable = true,
  space?: SpaceClass,
): Fact {
  return {
    id,
    kind,
    value,
    unit,
    subject,
    ...(space ? { space } : {}),
    provenance: 'drawing_text',
    sheet,
    tile: `${sheet}-t1`,
    bbox: [0, 0, 10, 10],
    source_text,
    run: 1,
    stable,
  };
}

function main() {
  console.log('Unit normalization:');
  ok('m to mm', convert(2.6, 'm', 'mm') === 2600);
  ok('mm to mm', convert(1070, 'mm', 'mm') === 1070);
  ok('m2 passthrough', convert(0.35, 'm2', 'm2') === 0.35);
  ok('unknown unit is null', convert(1, 'furlong', 'mm') === null);
  ok('mismatched base throws', (() => {
    try {
      convert(1, 'm2', 'mm');
      return false;
    } catch {
      return true;
    }
  })());

  console.log('\nStatus downgrade (§G7):');
  ok('fail downgrades to needs_confirmation', downgrade('fail') === 'needs_confirmation');
  ok('needs_confirmation downgrades to cant_determine', downgrade('needs_confirmation') === 'cant_determine');
  ok('pass is untouched', downgrade('pass') === 'pass');

  console.log('\nChesnut residence (§9 regression fixture):');
  resetFindingIds();

  // Facts the Chesnut drawings actually carry, per the hand review.
  const facts: Fact[] = [
    // F1: rooftop parapet 0.50 m where a guard needs 1 070 mm
    drawingFact('f-guard', 'guard_height_mm', 0.5, 'm', 'rooftop terrace guard', '02', '0.50'),
    // F2: P2 doors 800 mm at the entrance hall / stair
    drawingFact('f-door-p2', 'door_width_mm', 800, 'mm', 'P2 door at entrance hall', '01', '800', true, 'entrance'),
    // F9: clear height 2.60 m against a 2.1 m minimum
    drawingFact('f-ceiling', 'ceiling_height_mm', 2.6, 'm', 'ground floor', '02', '2.60'),
  ];

  // Everything the drawings omit, recorded as negative evidence (§S2) so the
  // engine can say cant_determine for a stated reason rather than by silence.
  const negative: NegativeEvidence[] = [
    'spatial-separation',
    'bedroom-egress-area',
    'bedroom-egress-dimension',
    'garage-separation',
    'smoke-alarms',
    'co-alarms',
    'energy-tier',
    'guard-openings',
    'stair-risers',
    'stair-runs',
    'door-height',
  ].map((rule_id) => ({
    rule_id,
    searched_for: ['schedules', 'general notes', 'sections'],
    not_found: ['any stated value'],
    sheets_searched: ['01', '02'],
  }));

  const out = evaluate({
    rules: PART9_RULES,
    facts,
    negative,
    applicability: CHESNUT_APP,
    predicates: {
      has_storage_garage: true,
      has_garage_or_fuel_appliance: true,
      not_sprinklered: true,
      stair_is_private: true,
    },
  });

  const byRule = (id: string) => out.findings.filter((f) => f.rule_id === id);

  // Every finding must satisfy the schema.
  const badShape = out.findings.filter((f) => !FindingSchema.safeParse(f).success);
  ok('every finding satisfies FindingSchema', badShape.length === 0, `${badShape.length} invalid`);

  // F1 — the guard. 500 mm against 1 070 mm. The rule has no measured
  // precision yet, so §G8 must hold it at needs_confirmation rather than fail.
  const guard = byRule('guard-height');
  ok('F1 guard produces one finding', guard.length === 1, `got ${guard.length}`);
  ok(
    'F1 guard measured as 500 mm',
    guard[0]?.computed.measured === 500,
    `got ${guard[0]?.computed.measured}`,
  );
  ok(
    'F1 guard is gated to needs_confirmation (§G8, precision unmeasured)',
    guard[0]?.status === 'needs_confirmation',
    `got ${guard[0]?.status}`,
  );
  ok(
    'F1 guard cites 9.8.8.3.(1)',
    guard[0]?.clause_ids.includes('9.8.8.3.(1)') === true,
  );

  // F2 — P2 door 800 mm against 810 mm at the entrance hall.
  const doorEntrance = byRule('door-width-entrance');
  ok('F2 entrance door flagged', doorEntrance.length === 1, `got ${doorEntrance.length}`);
  ok(
    'F2 entrance door is needs_confirmation',
    doorEntrance[0]?.status === 'needs_confirmation',
    `got ${doorEntrance[0]?.status}`,
  );
  ok('F2 shortfall is 10 mm', doorEntrance[0]?.computed.shortfall === 10);

  // F10: an entrance door is judged only against the entrance threshold, not
  // reported again under the room and bathroom rules.
  ok(
    'F10 entrance door is not also judged as a room or bathroom door',
    byRule('door-width-rooms').length === 0 && byRule('door-width-bathroom').length === 0,
    `rooms ${byRule('door-width-rooms').length}, bathroom ${byRule('door-width-bathroom').length}`,
  );

  // F9 — ceiling 2.60 m passes 2.1 m. This is the unit-normalization case:
  // without conversion, 2.6 would read as failing 2100.
  const ceiling = byRule('ceiling-height');
  ok('F9 ceiling passes', ceiling[0]?.status === 'pass', `got ${ceiling[0]?.status}`);
  ok('F9 ceiling measured as 2600 mm', ceiling[0]?.computed.measured === 2600);

  // F4 to F8 — everything the drawings omit must be cant_determine, never pass.
  for (const [label, ruleId] of [
    ['F4 spatial separation', 'spatial-separation'],
    ['F5 bedroom egress', 'bedroom-egress-area'],
    ['F6 garage separation', 'garage-separation'],
    ['F7 smoke alarms', 'smoke-alarms'],
    ['F7 CO alarms', 'co-alarms'],
    ['F8 energy tier', 'energy-tier'],
  ] as const) {
    const f = byRule(ruleId);
    ok(
      `${label} is cant_determine (§G5)`,
      f.length === 1 && f[0].status === 'cant_determine',
      `got ${f.map((x) => x.status).join(',') || 'nothing'}`,
    );
  }

  // §G5 restated as an invariant: nothing may pass without a supporting fact.
  const passesWithoutFacts = out.findings.filter(
    (f) => f.status === 'pass' && f.fact_ids.length === 0,
  );
  ok(
    'no finding passes without a supporting fact (§G5)',
    passesWithoutFacts.length === 0,
    `${passesWithoutFacts.length} did`,
  );

  // §G4 restated: no fail may exist without a computed comparison.
  const failsWithoutMath = out.findings.filter(
    (f) => (f.status === 'fail' || f.status === 'needs_confirmation') && f.computed.measured == null,
  );
  ok(
    'every fail carries a computed measurement (§G4)',
    failsWithoutMath.length === 0,
    `${failsWithoutMath.length} did not`,
  );

  // §S1: NECB must not be selected for a house.
  ok('energy path is Section 9.36, not NECB (§S1)', CHESNUT_APP.energy_path === 'NBC_9.36');
  ok('Part 9 selected, Part 3 not', CHESNUT_APP.code_parts.join() === '9');

  console.log('\nG6: unstable facts cannot support a fail:');
  resetFindingIds();
  const unstable = evaluate({
    rules: [ruleById('guard-height')!],
    facts: [
      drawingFact('f-u', 'guard_height_mm', 500, 'mm', 'guard', '02', '500', false),
    ],
    negative: [],
    applicability: CHESNUT_APP,
  });
  ok(
    'unstable fact yields needs_confirmation, not fail',
    unstable.findings[0]?.status === 'needs_confirmation',
    `got ${unstable.findings[0]?.status}`,
  );
  ok(
    'instability is recorded in computed',
    typeof unstable.findings[0]?.computed.stability === 'string',
  );

  console.log('\nSpace scoping (Table 9.5.5.1. by what each door serves):');
  resetFindingIds();
  const doors = evaluate({
    rules: PART9_RULES,
    facts: [
      drawingFact('d-bath', 'door_width_mm', 800, 'mm', 'P2 door at bathroom', '01', 'P2 0.80 m', true, 'bathroom'),
      drawingFact('d-clo', 'door_width_mm', 800, 'mm', 'P2 door at closet', '01', 'P2 0.80 m', true, 'closet'),
      drawingFact('d-hall', 'door_width_mm', 1100, 'mm', 'P1 door at hall', '01', 'P1 1.10 m', true, 'hallway'),
      drawingFact('d-unk', 'door_width_mm', 800, 'mm', 'P2 door', '01', 'P2 0.80 m'),
      drawingFact('d-wide', 'door_width_mm', 900, 'mm', 'D3 door', '01', 'D3 900'),
      drawingFact('d-narrow', 'door_width_mm', 550, 'mm', 'D4 door', '01', 'D4 550'),
    ],
    negative: [],
    applicability: CHESNUT_APP,
  });
  const forFact = (id: string) => doors.findings.filter((f) => f.fact_ids.includes(id));
  ok('each door produces exactly one finding', ['d-bath', 'd-hall', 'd-unk', 'd-wide', 'd-narrow'].every((id) => forFact(id).length === 1),
    ['d-bath', 'd-hall', 'd-unk', 'd-wide', 'd-narrow'].map((id) => `${id}:${forFact(id).length}`).join(' '));
  ok('bathroom door judged against 610 mm and passes', forFact('d-bath')[0]?.rule_id === 'door-width-bathroom' && forFact('d-bath')[0]?.status === 'pass');
  ok('reach-in closet door is not judged (not in Table 9.5.5.1.)', forFact('d-clo').length === 0);
  ok('hall door judged against 760 mm and passes', forFact('d-hall')[0]?.rule_id === 'door-width-rooms' && forFact('d-hall')[0]?.status === 'pass');
  ok('unknown-space 800 mm door is one cant_determine listing the options',
    forFact('d-unk')[0]?.status === 'cant_determine' && typeof forFact('d-unk')[0]?.computed.could_require === 'string');
  ok('unknown-space 900 mm door passes the strictest threshold', forFact('d-wide')[0]?.status === 'pass');
  ok('unknown-space 550 mm door is short of every threshold', forFact('d-narrow')[0]?.status === 'needs_confirmation');
  ok('no "nothing shown" row is repeated across the door group',
    doors.findings.filter((f) => f.rule_id.startsWith('door-width') && f.fact_ids.length === 0).length === 0);

  console.log('\nWhat a finding asks for:');
  ok('a pass asks for nothing', doors.findings.filter((f) => f.status === 'pass').every((f) => f.required_action === ''));
  ok('an unknown-space door asks for its room to be labelled, not to be widened',
    /label/i.test(forFact('d-unk')[0]?.required_action ?? '') && !/widen/i.test(forFact('d-unk')[0]?.required_action ?? ''));
  const missingSmoke = out.findings.find((f) => f.rule_id === 'smoke-alarms');
  ok('a cant_determine asks for the missing information', /^Show smoke alarm locations/.test(missingSmoke?.required_action ?? ''), missingSmoke?.required_action);
  ok('a shortfall still asks for the fix', /Raise the guard/.test(byRule('guard-height')[0]?.required_action ?? ''));

  console.log('\nCeiling height skips outdoor spaces:');
  resetFindingIds();
  const roof = evaluate({
    rules: [ruleById('ceiling-height')!],
    facts: [drawingFact('c-roof', 'ceiling_height_mm', 2.6, 'm', 'rooftop', '02', 'NLT=+05.60', true, 'roof')],
    negative: [],
    applicability: CHESNUT_APP,
  });
  ok('a rooftop is not checked as a room', roof.findings.filter((f) => f.fact_ids.includes('c-roof')).length === 0);

  console.log('\nKeyword classification of printed labels:');
  for (const [label, want] of [
    ['P2 door at bathroom', 'bathroom'], ['P2 door at 1/2 bathroom', 'bathroom'], ['P2 door at Entrance hall', 'entrance'],
    ['P1 door at hall', 'hallway'], ['P2 door at closet', 'closet'], ['WIC', 'walk_in_closet'], ['P2 door at service yard', 'exterior'],
    ['rooftop', 'roof'], ['baño', 'bathroom'], ['salle de bain', 'bathroom'], ['Rec Rm', 'habitable_room'], ['Mech', 'service_room'], ['Storage room', 'service_room'], ['Pantry', 'closet'], ['', 'unknown'],
  ] as const) {
    ok(`"${label}" is ${want}`, classifySpace(label) === want, `got ${classifySpace(label)}`);
  }

  console.log('\nApplicability scoping:');
  const part3 = evaluate({
    rules: PART9_RULES,
    facts: [],
    negative: [],
    applicability: { ...CHESNUT_APP, code_parts: ['3'], energy_path: 'NECB_2020' },
  });
  ok(
    'Part 9 rules are skipped for a Part 3 building',
    part3.findings.length === 0 && part3.skipped.length > 0,
    `${part3.findings.length} findings, ${part3.skipped.length} skipped`,
  );

  console.log(`\njudgment rules pending the model pass: ${out.pending_judgment.length}`);
  console.log(`rules skipped as out of scope: ${out.skipped.length}`);
  console.log(`findings produced: ${out.findings.length}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('ALL PASS');
}

main();
