#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const { retrieveCodeChunks, COMPLIANCE_CATEGORIES } = await import('../lib/retrieve');
  for (const cat of COMPLIANCE_CATEGORIES) {
    const q = `Part 9 housing dwelling unit small building ${cat.query}`;
    const chunks = await retrieveCodeChunks(q, { matchCount: 8, matchThreshold: 0.3, partPrefix: '9.' });
    console.log(`\n=== ${cat.key} (${chunks.length}) ===`);
    for (const c of chunks) {
      const body = (c.content ?? '').replace(/\s+/g, ' ').slice(0, 100);
      console.log(`  ${c.section_id} | ${body}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
