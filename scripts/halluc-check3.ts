#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const { compliancePass } = await import('../lib/analyze');
  const { supabaseAdmin } = await import('../lib/supabase');
  const { emptyExtractedSheet } = await import('../lib/types');
  const { emptyAnnotations } = await import('../lib/annotations');

  const sheet = {
    ...emptyExtractedSheet('A101_test.pdf', 'pdf' as const),
    rooms: [{ name: 'Bedroom 1', dimensions: '3 m x 3 m' }],
    doors: [
      { location: 'Main exit', width: '600 mm', type: 'swing' },
      { location: 'Bedroom 1', width: '500 mm', type: 'swing' },
    ],
    corridors: [{ location: 'Hallway', width: '700 mm', length: '5 m' }],
    stairs: [{ location: 'Main stair', width: '700 mm', rise: '230 mm', run: '210 mm' }],
    egress_paths: [{ from: 'Bedroom 1', to: 'Main exit', width: '600 mm' }],
    dimensions: [{ element: 'Ceiling height', value: '1.9', unit: 'm' }],
    occupancy_type: 'single-detached dwelling',
    building_type: 'Part 9 residential, 2 storeys',
    annotations: emptyAnnotations(),
  };

  console.log('--- compliance pass ---');
  const start = Date.now();
  const violations = await compliancePass(sheet);
  const elapsed = Date.now() - start;
  console.log(`${violations.length} violations in ${elapsed}ms\n`);
  for (const v of violations) {
    console.log(`  [${v.severity}] §${v.section_id ?? '—'} ${v.description.slice(0, 160)}`);
  }

  const cited = Array.from(new Set(violations.map((v) => v.section_id).filter(Boolean) as string[]));
  console.log(`\n--- verifying ${cited.length} cited ids appear in any chunk's content ---`);
  let real = 0; let fake = 0;
  for (const id of cited) {
    const { data } = await supabaseAdmin
      .from('building_code_chunks')
      .select('id')
      .ilike('content', `%${id}%`)
      .limit(1);
    if (data && data.length > 0) { real += 1; console.log('  REAL:', id); }
    else { fake += 1; console.log('  FAKE:', id); }
  }
  console.log(`real: ${real}  fake: ${fake}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
