// Reranking retrieved code chunks.
//
// lib/retrieve.ts is fast search: pgvector similarity, with a keyword fallback.
// It is good at producing a plausible shortlist and bad at ordering it, and in
// this corpus that gap is expensive. The chunker mislabels chunks, so
// lib/analyze.ts builds its citation allowlist by harvesting section numbers
// out of chunk *bodies* — which means every irrelevant chunk that reaches the
// prompt adds section numbers the model is then permitted to cite.
//
// Reranking scores each (query, chunk) pair on its own and keeps the best few,
// so the prompt carries fewer, better passages and a narrower allowlist.
//
// Like the verification gate, this can only ever remove candidates. With no
// TYPESAFE_API_KEY the shortlist passes through in fast-search order.

import { RETRIEVAL_QUESTIONS, THRESHOLDS, TYPESAFE_MODEL, typesafe, verificationEnabled } from './typesafe';
import type { CodeChunk } from './types';

const MAX_PASSAGE = 1500;
const CONCURRENCY = 8;

export interface ScoredChunk {
  chunk: CodeChunk;
  /** Probability the passage states a requirement governing the query, or null if unscored. */
  relevance: number | null;
}

export interface RerankOutput {
  kept: CodeChunk[];
  scored: ScoredChunk[];
  /** True when scores came from the model; false when it passed through unranked. */
  ranked: boolean;
}

async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One pair score. Returns null when the passage could not be judged. */
export async function scoreChunk(query: string, chunk: CodeChunk): Promise<number | null> {
  const passage = (chunk.content ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PASSAGE);
  if (!passage) return null;
  try {
    const response = await typesafe().systemOne({
      state: {
        looking_for: query,
        // The label is deliberately omitted: it is unreliable in this corpus,
        // and including it would let a wrong label vouch for the body.
        code_passage: passage,
      },
      questions: { relevant: RETRIEVAL_QUESTIONS.relevant },
      model: TYPESAFE_MODEL,
    });
    return response.answers.relevant.noul;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rerank] scoring failed', err);
    return null;
  }
}

/**
 * Reorder a fast-search shortlist and keep the best candidates.
 *
 * A chunk that could not be scored keeps its fast-search position rather than
 * being discarded — an outage must not empty the prompt.
 */
export async function rerankChunks(
  query: string,
  chunks: CodeChunk[],
  opts: { keep?: number; floor?: number } = {},
  // Seam for tests: swap the model call out without touching the network.
  score: typeof scoreChunk = scoreChunk,
): Promise<RerankOutput> {
  const keep = opts.keep ?? THRESHOLDS.retrievalKeep;
  const floor = opts.floor ?? THRESHOLDS.retrievalFloor;

  if (!verificationEnabled() || chunks.length === 0) {
    return {
      kept: chunks.slice(0, keep),
      scored: chunks.map((chunk) => ({ chunk, relevance: null })),
      ranked: false,
    };
  }

  const relevances = await pooled(chunks, CONCURRENCY, (c) => score(query, c));
  const scored: ScoredChunk[] = chunks.map((chunk, i) => ({ chunk, relevance: relevances[i] }));

  // Every score failing means the service is unavailable, not that nothing is
  // relevant. Fall back to fast-search order rather than returning nothing.
  if (scored.every((s) => s.relevance == null)) {
    return { kept: chunks.slice(0, keep), scored, ranked: false };
  }

  const above = scored
    .filter((s) => s.relevance != null && s.relevance >= floor)
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  // Unscored chunks are ranked last but stay eligible, so a single failed call
  // cannot hide an otherwise good passage.
  const unscored = scored.filter((s) => s.relevance == null);

  return {
    kept: [...above, ...unscored].slice(0, keep).map((s) => s.chunk),
    scored,
    ranked: true,
  };
}
