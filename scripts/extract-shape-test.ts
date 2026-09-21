#!/usr/bin/env ts-node
// Harness for the extraction shape coercer — no DB, no network, no env.
// Every fixture here is a real shape the vision model has returned instead of
// EXTRACTION_SCHEMA; before coerceExtraction they were silently discarded and
// the plan came back with "extraction empty" and no remarks.
import { coerceExtraction, extractionIsEmpty } from '../lib/extract';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('coerceExtraction:');

// A bare array of rooms, with dimensions as an array — observed from
// gemini-2.5-flash-lite on Sample-Floor-Plans.pdf.
const bareArray = coerceExtraction([
  { room_name: 'RECREATION RM.', room_type: 'NEW', dimensions: ['7307mm', '3606mm'] },
  { room_name: 'LAUNDRY', dimensions: [] },
]);
check('bare array becomes rooms', (bareArray.rooms?.length ?? 0) === 2, JSON.stringify(bareArray.rooms));
check(
  'array dimensions join into a string',
  bareArray.rooms?.[0].dimensions === '7307mm x 3606mm',
  String(bareArray.rooms?.[0].dimensions),
);

// The documented schema must survive untouched.
const schema = coerceExtraction({
  rooms: [{ name: 'Bedroom', dimensions: '3000mm x 3600mm' }],
  doors: [{ location: 'D-1', width: '810mm', type: 'swing' }],
  stairs: [{ location: 'S-1', width: '900mm', rise: '180mm', run: '255mm' }],
  dimensions: [{ element: 'ceiling height', value: '2.4', unit: 'm' }],
  occupancy_type: 'residential dwelling',
});
check('schema rooms preserved', schema.rooms?.[0].name === 'Bedroom');
check('schema door width preserved', schema.doors?.[0].width === '810mm');
check('schema stair run preserved', schema.stairs?.[0].run === '255mm');
check('schema dimension preserved', schema.dimensions?.[0].value === '2.4');
check('occupancy preserved', schema.occupancy_type === 'residential dwelling');

// Synonym keys, both for the arrays and the fields inside them.
const synonyms = coerceExtraction({
  spaces: [{ label: 'Kitchen', size: '3.0 x 4.2' }],
  doorways: [{ tag: 'D-3', clear_width: 750 }],
  hallways: [{ name: 'Hall A', width: '900mm' }],
  staircases: [{ id: 'S-2', riser: '210mm', tread: '240mm' }],
  exits: [{ from: 'Bedroom', to: 'Exterior', width: '850mm' }],
  measurements: [{ item: 'guard height', value: 850, unit: 'mm' }],
});
check('spaces → rooms', synonyms.rooms?.[0].name === 'Kitchen');
check('doorways → doors', synonyms.doors?.[0].location === 'D-3');
check('numeric width becomes a string', synonyms.doors?.[0].width === '750');
check('hallways → corridors', synonyms.corridors?.[0].width === '900mm');
check('staircases → stairs (riser/tread)', synonyms.stairs?.[0].rise === '210mm' && synonyms.stairs?.[0].run === '240mm');
check('exits → egress_paths', synonyms.egress_paths?.[0].width === '850mm');
check('measurements → dimensions', synonyms.dimensions?.[0].element === 'guard height');

// An unrecognised wrapper key still carries real elements.
const wrapped = coerceExtraction({ floor_plan: [{ room_name: 'Den' }, { door_id: 'D-9', width: '700mm' }] });
check('unknown wrapper key is still mined', (wrapped.rooms?.length ?? 0) === 1 && (wrapped.doors?.length ?? 0) === 1,
  JSON.stringify(wrapped));

// Nothing usable must stay empty rather than inventing elements.
for (const [name, input] of [
  ['empty object', {}],
  ['prose string', 'I could not read this drawing'],
  ['null', null],
  ['array of strings', ['ROOM A', 'ROOM B']],
] as Array<[string, unknown]>) {
  check(`${name} yields nothing`, extractionIsEmpty(coerceExtraction(input)));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
