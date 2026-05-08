#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

(async () => {
  const { consistencyPass } = await import('../lib/analyze');

  // Two synthetic sheets of the SAME project with planted contradictions:
  //   1. Bedroom 1 dimensions disagree (3500x4000 vs 3200x4000)
  //   2. Door D-01 width disagrees (900 vs 850)
  //   3. Sheet A-2 has a stair that A-1 does not
  const sheets = [
    {
      sheet_name: 'A-1 Floor Plan',
      file_type: 'pdf' as const,
      rooms: [
        { name: 'Bedroom 1', dimensions: '3500mm x 4000mm', area: '14m2' },
        { name: 'Bathroom', dimensions: '2000mm x 2500mm', area: '5m2' },
      ],
      doors: [
        { location: 'D-01 Bedroom 1 entry', width: '900mm', type: 'swing' },
        { location: 'D-02 Bath entry', width: '800mm', type: 'swing' },
      ],
      corridors: [{ location: 'Hall A-1', width: '1100mm', length: '6000mm' }],
      stairs: [],
      egress_paths: [{ from: 'Bedroom 1', to: 'Exit', width: '900mm' }],
      dimensions: [],
      annotations: [],
      occupancy_type: 'Group C',
      building_type: 'Single-detached dwelling',
    },
    {
      sheet_name: 'A-2 Door & Stair Schedule',
      file_type: 'pdf' as const,
      rooms: [
        { name: 'Bedroom 1', dimensions: '3200mm x 4000mm', area: '12.8m2' }, // contradiction
      ],
      doors: [
        { location: 'D-01 Bedroom 1 entry', width: '850mm', type: 'swing' }, // contradiction
        { location: 'D-02 Bath entry', width: '800mm', type: 'swing' },
      ],
      corridors: [],
      stairs: [{ location: 'Stair S-1', width: '900mm', rise: '180mm', run: '250mm' }], // missing on A-1
      egress_paths: [],
      dimensions: [],
      annotations: [],
    },
  ];

  console.log('Running consistencyPass on 2 synthetic sheets...');
  const t0 = Date.now();
  const violations = await consistencyPass(sheets);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.log(`[${v.severity.toUpperCase()}] ${v.description}`);
    if (v.affected_sheets?.length) console.log(`  sheets: ${v.affected_sheets.join(', ')}`);
    if (v.location_hint) console.log(`  loc:    ${v.location_hint}`);
    console.log();
  }
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
