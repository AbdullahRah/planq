#!/usr/bin/env ts-node
// Harness for retrieval reranking — no network, no credits, no Jev calls.
// scripts/rerank-eval.ts measures the judgements against the real corpus; this
// pins the behaviour around them: the cutoff, the ordering, and the fallbacks
// that must not empty a prompt when the service is unavailable.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'stub-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-service-key';
process.env.TYPESAFE_API_KEY ||= 'stub-typesafe-key';

import { rerankChunks } from '../lib/rerank';
import { harvestAllowedSections } from '../lib/analyze';
import type { CodeChunk } from '../lib/types';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const chunk = (id: string, section: string, content: string): CodeChunk => ({
  id,
  section_id: section,
  section_title: null,
  content,
});

// Deliberately mirrors the corpus: the chunk that carries the corridor-width
// requirement is labelled 9.8.5.2, not 9.9.3.3.
const SHORTLIST: CodeChunk[] = [
  chunk('a', '9.8.5.2#1', 'The width of every public corridor shall be not less than 1 100 mm. See 9.9.3.3.'),
  chunk('b', '9.36.1.3#44', 'The objectives and functional statements attributed to acceptable solutions in 9.36.2.1.'),
  chunk('c', '9.9.7#1', 'Corridors used by the public shall conform to 9.9.4.2. and 9.9.5.1.'),
  chunk('d', '9.33.5.1#2', 'This Subsection references CSA F280 for determining heating requirements.'),
];

const SCORES: Record<string, number> = { a: 0.91, b: 0.12, c: 0.64, d: 0.05 };

const run = (opts: Parameters<typeof rerankChunks>[2], score?: Parameters<typeof rerankChunks>[3]) =>
  rerankChunks('corridors: corridor width', SHORTLIST, opts, score ?? (async (_q, c) => SCORES[c.id]));

(async () => {
  console.log('\nrerankChunks — ordering and cutoff:');
  {
    const out = await run({ keep: 4, floor: 0.5 });
    check('drops candidates below the floor', out.kept.length === 2);
    check('keeps the highest scorer first', out.kept[0]?.id === 'a');
    check('orders by relevance, not fast-search position', out.kept[1]?.id === 'c');
    check('reports that it ranked', out.ranked);
    check('returns a score for every candidate', out.scored.length === 4);
  }

  console.log('\nrerankChunks — the keep limit:');
  {
    const out = await run({ keep: 1, floor: 0.0 });
    check('never returns more than `keep`', out.kept.length === 1);
    check('and returns the best one', out.kept[0]?.id === 'a');
  }

  console.log('\nrerankChunks — an outage must not empty the prompt:');
  {
    const out = await run({ keep: 3, floor: 0.5 }, async () => null);
    check('falls back to fast-search order', out.kept.map((c) => c.id).join(',') === 'a,b,c');
    check('says it did not rank', !out.ranked);
  }

  console.log('\nrerankChunks — a single failed score hides nothing:');
  {
    const out = await run({ keep: 4, floor: 0.5 }, async (_q, c) =>
      c.id === 'a' ? null : SCORES[c.id],
    );
    check('the unscored candidate stays eligible', out.kept.some((c) => c.id === 'a'));
    check('scored candidates still rank above it', out.kept[0]?.id === 'c');
  }

  console.log('\nrerankChunks — degenerate inputs:');
  {
    const empty = await rerankChunks('q', [], { keep: 4 }, async () => 1);
    check('an empty shortlist yields nothing', empty.kept.length === 0);
    const unscorable = await rerankChunks(
      'q',
      [chunk('e', '9.1', '')],
      { keep: 4 },
      async () => null,
    );
    check('a blank passage does not crash', unscorable.kept.length === 1);
  }

  console.log('\nthe point of it — a narrower citation allowlist:');
  {
    const out = await run({ keep: 4, floor: 0.5 });
    const before = harvestAllowedSections(SHORTLIST);
    const after = harvestAllowedSections(out.kept);
    check(
      'reranking shrinks what the model may cite',
      after.size < before.size,
      `${before.size} -> ${after.size}`,
    );
    check(
      'the section the requirement actually lives in survives',
      after.has('9.9.3.3'),
      'harvested from the body of a chunk mislabelled 9.8.5.2',
    );
    check(
      'irrelevant sections are no longer citable',
      !after.has('9.36.2.1') && !after.has('9.33.5.1'),
    );
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
