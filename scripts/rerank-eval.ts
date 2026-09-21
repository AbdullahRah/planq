#!/usr/bin/env ts-node
// Live evaluation of retrieval reranking against the real NBC Alberta 2019
// corpus in building_code_chunks. Calls the Jev API; costs a few thousand
// input tokens per category.
//
//   npm run rerank:eval
//
// What it measures, and why:
//
// lib/analyze.ts lets the model cite any section number it can see — including
// numbers harvested out of chunk *bodies*, because the chunker mislabels chunks
// so badly that trusting labels alone would reject most real citations. That
// allowlist is therefore the surface on which a wrong-but-permitted citation
// becomes possible, and it grows with every irrelevant chunk in the prompt.
//
// So the metric is not "is the ranking prettier". It is:
//
//   1. does the section that genuinely answers the query survive reranking, and
//   2. how much smaller is the permitted-citation surface afterwards.
//
// A run that shrinks the allowlist but loses a gold section is a regression,
// and fails.

import { config } from 'dotenv';
config({ path: '.env.local' });

import { COMPLIANCE_CATEGORIES, retrieveCodeChunks } from '../lib/retrieve';
import { rerankChunks } from '../lib/rerank';
import { harvestAllowedSections } from '../lib/analyze';
import { THRESHOLDS } from '../lib/typesafe';

// A phrase that only appears in a passage genuinely answering the category.
// Each is a requirement verified present in the corpus, not a guess.
// No gold for `occupancy`: the only chunks in this corpus mentioning "major
// occupancy" are 9.36 energy-efficiency text, so there is nothing correct for
// that category to retrieve. Reranking drops those, which is the right call but
// not something a gold marker can assert. Fixing it means fixing the query or
// the corpus, not the reranker.
const GOLD: Record<string, { marker: string; what: string }> = {
  corridors: { marker: '1 100 mm', what: 'public corridors shall be not less than 1 100 mm' },
  stairs: { marker: '1 950 mm', what: 'stair headroom shall be not less than 1 950 mm' },
  doors: { marker: '810 mm', what: 'doorway width requirement of 810 mm' },
  egress: { marker: 'travel distance', what: 'travel-distance limits for access to exit' },
};

function has(text: string | null | undefined, marker: string): boolean {
  return (text ?? '').replace(/\s+/g, ' ').includes(marker);
}

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('TYPESAFE_API_KEY is not set — add it to .env.local');
    process.exit(1);
  }

  console.log(
    `floor=${THRESHOLDS.retrievalFloor} keep=${THRESHOLDS.retrievalKeep}  (lib/typesafe.ts)\n`,
  );

  let candidatesTotal = 0;
  let keptTotal = 0;
  let allowBefore = 0;
  let allowAfter = 0;
  const goldLost: string[] = [];
  const started = Date.now();

  for (const cat of COMPLIANCE_CATEGORIES) {
    const shortlist = await retrieveCodeChunks(`Part 9 housing dwelling unit ${cat.query}`, {
      matchCount: 8,
      matchThreshold: 0.3,
      partPrefix: '9.',
    });
    if (shortlist.length === 0) {
      console.log(`${cat.key.padEnd(12)} no candidates retrieved — skipped`);
      continue;
    }

    const ranked = await rerankChunks(`${cat.key}: ${cat.query}`, shortlist);

    const before = harvestAllowedSections(shortlist);
    const after = harvestAllowedSections(ranked.kept);
    candidatesTotal += shortlist.length;
    keptTotal += ranked.kept.length;
    allowBefore += before.size;
    allowAfter += after.size;

    const gold = GOLD[cat.key];
    let goldNote = '';
    if (gold) {
      const inShortlist = shortlist.some((c) => has(c.content, gold.marker));
      const survived = ranked.kept.some((c) => has(c.content, gold.marker));
      if (!inShortlist) {
        goldNote = `  gold NOT RETRIEVED by fast search (${gold.marker}) — rerank cannot recover it`;
      } else if (survived) {
        goldNote = `  gold survived (${gold.marker})`;
      } else {
        goldNote = `  GOLD LOST (${gold.marker})`;
        goldLost.push(cat.key);
      }
    }

    console.log(
      `${cat.key.padEnd(12)} ${String(shortlist.length).padStart(2)} candidates -> ${ranked.kept.length} kept   allowlist ${String(before.size).padStart(3)} -> ${String(after.size).padStart(3)}${goldNote}`,
    );

    // Show the scores so a bad cutoff is visible rather than inferred.
    for (const s of [...ranked.scored].sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1))) {
      const inKept = ranked.kept.includes(s.chunk);
      const title = (s.chunk.section_title ?? '').replace(/\s+/g, ' ').slice(0, 44);
      console.log(
        `             ${inKept ? 'keep' : 'drop'} ${(s.relevance?.toFixed(2) ?? ' n/a').padStart(4)}  ${(s.chunk.section_id ?? '—').padEnd(12)} ${title}`,
      );
    }
    console.log();
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const shrink = allowBefore > 0 ? Math.round((1 - allowAfter / allowBefore) * 100) : 0;
  console.log(`candidates retrieved:        ${candidatesTotal}`);
  console.log(`chunks kept:                 ${keptTotal}`);
  console.log(`permitted citations:         ${allowBefore} -> ${allowAfter}  (${shrink}% smaller)`);
  console.log(`gold sections lost:          ${goldLost.length === 0 ? 'none' : goldLost.join(', ')}`);
  console.log(`${seconds}s total`);

  process.exit(goldLost.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
