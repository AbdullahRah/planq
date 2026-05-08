import { openrouter, MODELS } from './openrouter';
import { supabaseAdmin } from './supabase';
import type { CodeChunk } from './types';

export async function embedQuery(query: string): Promise<number[]> {
  const response = await openrouter.embeddings.create({
    model: MODELS.embedding,
    input: query,
  });
  const vector = response.data?.[0]?.embedding;
  if (!vector) throw new Error('embedding response missing data');
  return vector as number[];
}

export async function retrieveCodeChunks(
  query: string,
  opts: { matchThreshold?: number; matchCount?: number } = {},
): Promise<CodeChunk[]> {
  const { matchThreshold = 0.5, matchCount = 10 } = opts;
  let embedding: number[];
  try {
    embedding = await embedQuery(query);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[retrieve] embedding failed', err);
    return [];
  }

  const { data, error } = await supabaseAdmin.rpc('match_code_chunks', {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[retrieve] rpc match_code_chunks failed', error);
    return [];
  }
  return (data ?? []) as CodeChunk[];
}

export const COMPLIANCE_CATEGORIES = [
  {
    key: 'egress',
    query: 'egress width requirements corridor minimum exit access travel distance',
  },
  {
    key: 'doors',
    query: 'door width swing direction fire-rated assembly opening protectives',
  },
  {
    key: 'corridors',
    query: 'corridor width dead-end length fire separation public corridor',
  },
  {
    key: 'stairs',
    query: 'stair width rise run handrail guardrail headroom landing requirements',
  },
  {
    key: 'occupancy',
    query: 'occupancy classification group major occupancy load building area limits',
  },
] as const;
