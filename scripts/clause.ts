#!/usr/bin/env ts-node
// Look up any article or sentence by id (PLANQ_SPEC.md §11 step 1).
//
//   npm run clause 9.8.8.3.          -- every sentence of the article
//   npm run clause 9.8.8.3.(1)       -- one sentence
//   npm run clause -- --search guard -- articles mentioning a phrase

import path from 'path';
import { config as loadEnv } from 'dotenv';
import { loadCodeStore, lookupClauses, searchClauses } from '../lib/code-store';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

function print(c: {
  id: string;
  title: string;
  text: string;
  printed_page: string;
  pdf_page: number;
  cross_refs: string[];
  notes: string[];
}) {
  console.log(`\n${c.id}  ${c.title}`);
  console.log(`  printed p.${c.printed_page}  pdf p.${c.pdf_page}`);
  console.log(`  ${c.text.replace(/(.{1,96})(\s|$)/g, '$1\n  ').trimEnd()}`);
  if (c.cross_refs.length) console.log(`  refs: ${c.cross_refs.join(', ')}`);
  if (c.notes.length) console.log(`  notes: ${c.notes.join(', ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const store = await loadCodeStore();

  if (args[0] === '--search') {
    const phrase = args.slice(1).join(' ');
    const hits = await searchClauses(phrase);
    console.log(`${hits.length} clause(s) mentioning "${phrase}"`);
    for (const h of hits) print(h);
    return;
  }

  const id = args[0];
  if (!id) {
    console.log(
      `clause store: ${store.edition} (${store.printing})\n` +
        `  ${store.clauses.length} clauses, ${store.pdf_pages} pdf pages\n` +
        `  store_sha256=${store.store_sha256.slice(0, 16)}…\n\n` +
        'usage: npm run clause 9.8.8.3.   |   npm run clause -- --search guard',
    );
    return;
  }

  const found = await lookupClauses(id);
  if (found.length === 0) {
    console.error(`no clause found for "${id}"`);
    process.exit(1);
  }
  for (const c of found) print(c);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
