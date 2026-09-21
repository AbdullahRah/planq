#!/usr/bin/env ts-node
// Harness for the Extend output mapper — no network, no credits, no Extend calls.
// Every fixture is the shape api/extend_extract.py returns after a real run, so
// this is where a schema change in extend/extract.config.json gets caught.
//
// lib/supabase.ts builds its client at module load and throws on an empty URL,
// so stub the env before importing the module under test. Nothing here touches
// Supabase; the stubs only get the import to complete.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'stub-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-service-key';

import { parseDimension } from '../lib/rule-engine/units';
import type { ExtractedSheet } from '../lib/types';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// A realistic PROCESSED output: citations are enabled, so the schema data sits
// under `value` and per-field confidence sits under `metadata`.
const CITED_OUTPUT = {
  value: {
    occupancy_classification: 'Group C',
    building_type: 'single detached dwelling',
    rooms: [
      {
        room_name: 'BEDROOM 2',
        room_width: { value: 3000, unit: 'mm' },
        room_length: { value: 3600, unit: 'mm' },
        room_floor_area: { value: 10.8, unit: 'm' },
        ceiling_height: { value: 2440, unit: 'mm' },
      },
    ],
    doors: [
      {
        door_label: 'D-1',
        door_clear_width: { value: 810, unit: 'mm' },
        door_height: { value: 2032, unit: 'mm' },
        door_type: 'swing',
        is_exterior_door: true,
      },
    ],
    corridors: [
      {
        corridor_location: 'hallway between bedroom 2 and bathroom',
        corridor_clear_width: { value: 900, unit: 'mm' },
        corridor_length: { value: 4200, unit: 'mm' },
      },
    ],
    stairs: [
      {
        stair_location: 'S-1',
        stair_clear_width: { value: 860, unit: 'mm' },
        riser_height: { value: 190, unit: 'mm' },
        tread_run: { value: 255, unit: 'mm' },
        headroom_height: { value: 1950, unit: 'mm' },
        riser_count: 14,
      },
    ],
    egress_paths: [
      {
        path_origin: 'bedroom 1',
        path_destination: 'front entry door',
        path_clear_width: { value: 900, unit: 'mm' },
        travel_distance: { value: 12.5, unit: 'm' },
      },
    ],
    dimensions: [
      { dimension_element: 'guard height at deck', dimension_value: { value: 1070, unit: 'mm' } },
    ],
    plan_notes: ['ALL DIMENSIONS IN MILLIMETRES', 'FIRE SEPARATION 45 MIN'],
  },
  metadata: {
    'doors[0].door_clear_width': { ocrConfidence: 0.42 },
    'rooms[0].room_name': { ocrConfidence: 0.99 },
    'stairs[0].riser_height': { ocrConfidence: 0.55 },
  },
};

(async () => {
  const {
    mapExtendOutput,
    formatMeasurement,
    lowConfidenceFields,
    extractSheetViaExtend,
  } = await import('../lib/extend-extract');

  console.log('formatMeasurement:');
  check('value + unit becomes a united string', formatMeasurement({ value: 810, unit: 'mm' }) === '810 mm');
  check('null value yields nothing', formatMeasurement({ value: null, unit: 'mm' }) === undefined);
  check('non-object yields nothing', formatMeasurement('810mm') === undefined);
  check(
    'unreadable unit falls back to a bare number',
    formatMeasurement({ value: 810, unit: null }) === '810',
  );
  check(
    'an unrecognised unit is not passed through',
    formatMeasurement({ value: 810, unit: 'furlong' }) === '810',
  );

  // The whole reason the schema asks for a number and a unit separately: the
  // rule engine can only trust a magnitude whose unit was stated.
  console.log('\nunits round-trip (why numeric+unit was chosen):');
  for (const [input, expectedMm] of [
    [{ value: 810, unit: 'mm' }, 810],
    [{ value: 0.9, unit: 'm' }, 900],
    [{ value: 36, unit: 'in' }, 914.4],
    [{ value: 90, unit: 'cm' }, 900],
  ] as Array<[unknown, number]>) {
    const parsed = parseDimension(formatMeasurement(input));
    check(
      `${JSON.stringify(input)} -> ${expectedMm}mm with an explicit unit`,
      !!parsed && Math.abs(parsed.mm - expectedMm) < 0.01 && parsed.explicitUnit,
      JSON.stringify(parsed),
    );
  }
  const bare = parseDimension(formatMeasurement({ value: 2.4, unit: null }));
  check(
    'a unit Extend could not read stays flagged as non-explicit',
    !!bare && bare.explicitUnit === false,
    JSON.stringify(bare),
  );

  console.log('\nmapExtendOutput:');
  const mapped = mapExtendOutput(CITED_OUTPUT);
  check('unwraps the citations `value` envelope', (mapped.rooms?.length ?? 0) === 1);
  check('occupancy classification maps across', mapped.occupancy_type === 'Group C');
  check('building type maps across', mapped.building_type === 'single detached dwelling');
  check('room dimensions become "W x L"', mapped.rooms?.[0].dimensions === '3000 mm x 3600 mm');
  check('room area carries its unit', mapped.rooms?.[0].area === '10.8 m');
  check('door width is united', mapped.doors?.[0].width === '810 mm');
  check('exterior flag reaches the door type', (mapped.doors?.[0].type ?? '').includes('exterior'));
  check('corridor width maps', mapped.corridors?.[0].width === '900 mm');
  check('stair rise and run map', mapped.stairs?.[0].rise === '190 mm' && mapped.stairs?.[0].run === '255 mm');
  check('egress path endpoints map', mapped.egress_paths?.[0].from === 'bedroom 1');

  // Measurements with no typed home must land in `dimensions`, which the rule
  // engine reads — otherwise a ceiling height Extend read would be discarded.
  const dimElements = (mapped.dimensions ?? []).map((d) => d.element);
  check('ceiling height is kept', dimElements.some((e) => e.includes('ceiling height')), dimElements.join(' | '));
  check('door height is kept', dimElements.some((e) => e.includes('D-1 height')));
  check('stair headroom is kept', dimElements.some((e) => e.includes('headroom')));
  check('travel distance is kept', dimElements.some((e) => e.includes('travel distance')));
  check('sheet dimensions are kept', dimElements.some((e) => e === 'guard height at deck'));
  check(
    'dimension value and unit stay separate',
    (mapped.dimensions ?? []).some((d) => d.value === '1070' && d.unit === 'mm'),
  );
  check('riser count becomes an annotation', (mapped.annotations as string[]).some((a) => a.includes('14 risers')));
  check('plan notes become annotations', (mapped.annotations as string[]).includes('FIRE SEPARATION 45 MIN'));

  // A config change that turns citations off moves the data to the top level.
  const bareShape = mapExtendOutput({ rooms: [{ room_name: 'DEN' }], plan_notes: [] });
  check('un-cited output still maps', bareShape.rooms?.[0].name === 'DEN');

  console.log('\nnothing is invented:');
  for (const [name, input] of [
    ['empty object', {}],
    ['null', null],
    ['string', 'no data'],
    ['empty value envelope', { value: {}, metadata: {} }],
  ] as Array<[string, unknown]>) {
    const out = mapExtendOutput(input);
    const empty =
      (out.rooms?.length ?? 0) === 0 &&
      (out.doors?.length ?? 0) === 0 &&
      (out.dimensions?.length ?? 0) === 0 &&
      !out.occupancy_type;
    check(`${name} yields nothing`, empty, JSON.stringify(out));
  }

  console.log('\nlowConfidenceFields:');
  const flagged = lowConfidenceFields(CITED_OUTPUT);
  check('flags readings below the threshold', flagged.length === 2, flagged.join(', '));
  check('names the field and its score', flagged.some((f) => f.startsWith('doors[0].door_clear_width (0.42)')));
  check('leaves confident readings alone', !flagged.some((f) => f.includes('room_name')));
  check('no metadata yields no flags', lowConfidenceFields({ value: {} }).length === 0);

  console.log('\nextractSheetViaExtend:');
  const sheetName = 'A1.1-floor-plan.pdf';
  const ok: ExtractedSheet = await extractSheetViaExtend({
    sheetName,
    fileType: 'pdf',
    storagePath: 'plan/1-A1.1.pdf',
    deps: {
      sign: async () => 'https://signed.example/A1.1.pdf',
      call: async () => ({ ok: true, runId: 'exr_live', status: 'PROCESSED', output: CITED_OUTPUT }),
    },
  });
  check('a processed run produces a populated sheet', ok.rooms.length === 1 && ok.doors.length === 1);
  check('the sheet keeps its name and type', ok.sheet_name === sheetName && ok.file_type === 'pdf');
  check('the run id is recorded', ok.annotations.other.some((o) => o === 'EXTEND_RUN: exr_live'));
  check(
    'low-confidence readings are surfaced on the sheet',
    ok.annotations.other.some((o) => o.startsWith('EXTEND_LOW_CONFIDENCE:')),
    ok.annotations.other.join(' | '),
  );

  // A failed read must be loudly empty. app/api/analyze/route.ts lifts
  // EXTEND_ERROR into the response warnings, and sheetHasUsableData() keeps the
  // sheet out of the compliance pass — so it can never read as "no violations".
  const failed = await extractSheetViaExtend({
    sheetName,
    fileType: 'pdf',
    storagePath: 'plan/1-A1.1.pdf',
    deps: {
      sign: async () => 'https://signed.example/A1.1.pdf',
      call: async () => ({
        ok: false,
        error: { code: 'USAGE_BLOCKED', message: 'credits exhausted', requestId: 'req_1' },
      }),
    },
  });
  const errNote = failed.annotations.other.find((o) => o.startsWith('EXTEND_ERROR:')) ?? '';
  check('a failed run yields an empty sheet', failed.rooms.length === 0 && failed.doors.length === 0);
  check('the error code is reported', errNote.includes('USAGE_BLOCKED'), errNote);
  check('the request id is reported', errNote.includes('req_1'), errNote);

  const signFailed = await extractSheetViaExtend({
    sheetName,
    fileType: 'pdf',
    storagePath: 'plan/missing.pdf',
    deps: {
      sign: async () => {
        throw new Error('object not found');
      },
      call: async () => ({ ok: true, output: CITED_OUTPUT }),
    },
  });
  check(
    'a signing failure is reported, not swallowed',
    signFailed.annotations.other.some((o) => o.startsWith('EXTEND_ERROR:') && o.includes('object not found')),
  );

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
