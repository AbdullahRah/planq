#!/usr/bin/env ts-node
// Build the clause store from the NBC(AE) PDF (PLANQ_SPEC.md §11 step 1).
//
//   npm run code:build                 -- full build with G1 assertions
//   npm run code:build -- --pages 1-80 -- parse a slice, skipping G1 (probing only)
//
// Output: data/code-store.json, plus a manifest recording the source hash so a
// run's audit trail (§G10) can name the exact store it used.

import path from 'path';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { config as loadEnv } from 'dotenv';
import { openPdf, type PageText } from '../lib/code-store/extract';
import { assertCorpusComplete, parseClauses } from '../lib/code-store/parse';
import { NBCAE_2023_PAGES, EDITION, PRINTING } from '../lib/schemas';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

const PDF = path.resolve(process.cwd(), 'data/NBCAE-2023.pdf');
const OUT = path.resolve(process.cwd(), 'data/code-store.json');

/** Articles every rule in §6 cites. G1 fails the build if any is missing. */
const REQUIRED_ARTICLES = [
  '9.5.3.1.',
  '9.5.5.1.',
  '9.8.4.1.',
  '9.8.4.2.',
  '9.8.8.3.',
  '9.8.8.5.',
  '9.9.10.1.',
  '9.10.9.18.',
  '9.10.13.15.',
  '9.10.15.4.',
  '9.10.15.5.',
  '9.10.19.1.',
  '9.10.19.3.',
  '9.32.3.9.',
];

function parseRange(arg: string | undefined, max: number): [number, number] {
  if (!arg) return [1, max];
  const m = arg.match(/^(\d+)-(\d+)$/);
  if (!m) throw new Error(`--pages expects "start-end", got "${arg}"`);
  return [Math.max(1, Number(m[1])), Math.min(max, Number(m[2]))];
}

async function main() {
  const args = process.argv.slice(2);
  const pagesArg = args.includes('--pages') ? args[args.indexOf('--pages') + 1] : undefined;
  const probing = Boolean(pagesArg);

  const buf = await fs.readFile(PDF);
  const sourceHash = createHash('sha256').update(buf).digest('hex');
  console.log(`[code-store] ${path.basename(PDF)}  sha256=${sourceHash.slice(0, 16)}…`);

  const doc = await openPdf(PDF);
  const [from, to] = parseRange(pagesArg, doc.numPages);
  console.log(`[code-store] ${doc.numPages} pages; parsing ${from}-${to}`);

  const pages: PageText[] = [];
  for (let p = from; p <= to; p++) {
    pages.push(await doc.page(p));
    if ((p - from + 1) % 100 === 0) {
      console.log(`[code-store]   …${p - from + 1}/${to - from + 1} pages read`);
    }
  }

  const { clauses, articleTitles } = parseClauses(pages);
  const missing = REQUIRED_ARTICLES.filter((a) => !articleTitles.has(a));

  console.log(
    `[code-store] parsed ${clauses.length} clauses across ${articleTitles.size} articles`,
  );
  if (missing.length > 0) {
    console.log(`[code-store] missing required articles: ${missing.join(', ')}`);
  }

  if (probing) {
    console.log('[code-store] --pages given: skipping G1 and not writing the store');
    for (const a of REQUIRED_ARTICLES) {
      if (articleTitles.has(a)) console.log(`  found ${a}  ${articleTitles.get(a)}`);
    }
    return;
  }

  assertCorpusComplete(
    {
      pdf_pages: doc.numPages,
      clauses: clauses.length,
      articles: articleTitles.size,
      missing_articles: missing,
    },
    NBCAE_2023_PAGES,
    REQUIRED_ARTICLES,
  );

  const storeHash = createHash('sha256')
    .update(clauses.map((c) => c.sha256).join(''))
    .digest('hex');

  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        edition: EDITION,
        printing: PRINTING,
        source_pdf: path.basename(PDF),
        source_sha256: sourceHash,
        store_sha256: storeHash,
        pdf_pages: doc.numPages,
        built_at: new Date().toISOString(),
        clauses,
      },
      null,
      1,
    ),
  );
  console.log(`[code-store] wrote ${OUT}`);
  console.log(`[code-store] store_sha256=${storeHash.slice(0, 16)}…  G1 PASS`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
