#!/usr/bin/env ts-node
// Live evaluation of NBC Part resolution (lib/occupancy-resolve.ts).
//
//   npm run occupancy:eval
//
// Ground truth here is hand-labelled from Part 9's own limits — 3 storeys or
// fewer, 600 m² or less in building area, and a qualifying occupancy. The model
// is not asked to grade itself.
//
// The Part decides which deterministic rules run, so the property that matters
// most is not accuracy on clear cases. It is refusal on unclear ones: a
// confident wrong Part silently changes every limit applied to the sheet, while
// an honest "unknown" just leaves the engine behaving as it does today.

import { config } from 'dotenv';
config({ path: '.env.local' });

import { resolveBuildingPart } from '../lib/occupancy-resolve';
import { emptyExtractedSheet, type ExtractedSheet } from '../lib/types';
import { emptyAnnotations } from '../lib/annotations';
import { THRESHOLDS } from '../lib/typesafe';

type Expect = 'Part9' | 'Part3' | 'unknown';

function sheet(over: Partial<ExtractedSheet>): ExtractedSheet {
  return { ...emptyExtractedSheet('X.pdf', 'pdf'), annotations: emptyAnnotations(), ...over };
}

const CASES: Array<{ id: string; expect: Expect; why: string; sheet: ExtractedSheet }> = [
  {
    id: 'stated_part9',
    expect: 'Part9',
    why: 'the sheet says "single detached dwelling" — the regex resolves this without a model call',
    sheet: sheet({
      occupancy_type: 'Group C residential',
      building_type: 'single detached dwelling, 2 storeys',
      rooms: [{ name: 'BEDROOM 1' }],
    }),
  },
  {
    id: 'inferred_part9_from_notes',
    expect: 'Part9',
    // Known conservative miss. The fixture carries a deliberate distractor:
    // building area (420 m², the number Part 9 turns on) sits next to gross
    // floor area (1 150 m², which does not). A reviewer would still say Part 9,
    // and jev-1.13.0 answers Part9 — at ~0.81, under the 0.85 bar, so it falls
    // back to unknown and the engine behaves as it does today. The threshold is
    // deliberately not lowered to make this pass; see VERIFICATION.md.
    why: 'no stated occupancy; notes give 3 storeys and 420 m² building area — inside both Part 9 limits, but a gross-floor-area distractor sits beside it',
    sheet: sheet({
      rooms: [{ name: 'BEDROOM 1' }, { name: 'BEDROOM 2' }, { name: 'ENSUITE' }, { name: 'GARAGE' }],
      annotations: {
        ...emptyAnnotations(),
        levels: ['3 STOREYS ABOVE GRADE'],
        totals: ['TOTAL BUILDING AREA: 420 m2', 'GROSS FLOOR AREA 1150 m2'],
        other: ['ROW HOUSING UNIT TYPE B', 'NO SPRINKLER SYSTEM'],
      },
    }),
  },
  {
    id: 'inferred_part3_by_height',
    expect: 'Part3',
    why: 'no stated occupancy, but 8 storeys exceeds the Part 9 limit of 3 regardless of use',
    sheet: sheet({
      rooms: [{ name: 'OFFICE 401' }, { name: 'LOBBY' }, { name: 'ELEV MACH RM' }],
      annotations: {
        ...emptyAnnotations(),
        levels: ['LEVEL 8 FLOOR PLAN', '8 STOREYS ABOVE GRADE'],
        totals: ['BUILDING AREA 1 850 m2'],
        other: ['OFFICE TOWER — SPRINKLERED THROUGHOUT'],
      },
    }),
  },
  {
    id: 'inferred_part3_by_occupancy',
    expect: 'Part3',
    why: 'no stated occupancy, but an assembly occupancy is Part 3 at any size',
    sheet: sheet({
      rooms: [{ name: 'AUDITORIUM' }, { name: 'STAGE' }, { name: 'LOBBY' }],
      annotations: {
        ...emptyAnnotations(),
        levels: ['2 STOREYS'],
        totals: ['OCCUPANT LOAD 450 PERSONS', 'BUILDING AREA 1 200 m2'],
        other: ['COMMUNITY THEATRE — ASSEMBLY OCCUPANCY GROUP A2'],
      },
    }),
  },
  {
    id: 'refuses_on_room_names_only',
    expect: 'unknown',
    why: 'SAFETY: bedrooms suggest housing, but nothing states storeys or area — it must not guess',
    sheet: sheet({
      rooms: [{ name: 'BEDROOM 1' }, { name: 'BEDROOM 2' }, { name: 'BATH' }],
    }),
  },
  {
    id: 'refuses_on_empty_sheet',
    expect: 'unknown',
    why: 'SAFETY: a sheet with no descriptive content supports no Part at all',
    sheet: sheet({ dimensions: [{ element: 'grid', value: '6000', unit: 'mm' }] }),
  },
];

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('TYPESAFE_API_KEY is not set — add it to .env.local');
    process.exit(1);
  }
  console.log(`occupancyAutoAccept=${THRESHOLDS.occupancyAutoAccept}  (lib/typesafe.ts)\n`);

  let correct = 0;
  const unsafe: string[] = [];

  for (const c of CASES) {
    const r = await resolveBuildingPart(c.sheet);
    const got: Expect = r.part ?? 'unknown';
    const hit = got === c.expect;
    if (hit) correct += 1;

    // The unsafe outcome: asserting a Part the evidence does not support.
    if (c.expect === 'unknown' && r.part) unsafe.push(c.id);
    // Also unsafe: contradicting the sheet's own clear statement.
    if (c.expect !== 'unknown' && r.part && r.part !== c.expect) unsafe.push(c.id);

    console.log(
      `${hit ? 'ok  ' : 'MISS'} ${c.id.padEnd(30)} expected=${c.expect.padEnd(8)} got=${got.padEnd(8)} source=${r.source.padEnd(8)} conf=${r.confidence?.toFixed(2) ?? '—'}`,
    );
    console.log(`       ${c.why}`);
    if (r.note) console.log(`       note: ${r.note}`);
    console.log();
  }

  console.log(`correct:                     ${correct}/${CASES.length}`);
  console.log(`unsupported Part asserted:   ${unsafe.length === 0 ? 'none' : unsafe.join(', ')}`);
  process.exit(unsafe.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
