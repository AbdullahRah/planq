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

async function keywordFallback(
  query: string,
  limit: number,
  partPrefix?: string,
): Promise<CodeChunk[]> {
  // planq.md §5: fallback search when vector retrieval is unavailable or empty.
  // Pick the most distinctive terms from the query and OR them across content
  // and section_title via Postgres ilike.
  const stop = new Set([
    'the','and','or','for','of','to','a','an','in','on','at','by','with','from',
    'is','are','be','requirements','minimum','maximum','width','length',
  ]);
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !stop.has(t)),
    ),
  ).slice(0, 4);

  if (terms.length === 0) return [];

  const pattern = terms.map((t) => `content.ilike.%${t}%,section_title.ilike.%${t}%`).join(',');
  let q = supabaseAdmin
    .from('building_code_chunks')
    .select('id, section_id, section_title, content')
    .or(pattern);
  if (partPrefix) q = q.like('section_id', `${partPrefix}%`);
  const { data, error } = await q.limit(limit);

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[retrieve] keyword fallback failed', error);
    return [];
  }
  return (data ?? []) as CodeChunk[];
}

export async function retrieveCodeChunks(
  query: string,
  opts: { matchThreshold?: number; matchCount?: number; partPrefix?: string } = {},
): Promise<CodeChunk[]> {
  const { matchThreshold = 0.5, matchCount = 10, partPrefix } = opts;
  let embedding: number[] | null = null;
  try {
    embedding = await embedQuery(query);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[retrieve] embedding failed, will try keyword fallback', err);
  }

  if (embedding) {
    // Over-fetch and then filter to part when requested, so we still get
    // enough chunks after filtering.
    const overfetch = partPrefix ? Math.max(matchCount * 8, 40) : matchCount;
    const { data, error } = await supabaseAdmin.rpc('match_code_chunks', {
      query_embedding: embedding,
      match_threshold: matchThreshold,
      match_count: overfetch,
    });

    if (error) {
      // eslint-disable-next-line no-console
      console.error('[retrieve] rpc match_code_chunks failed', error);
    } else if (data && data.length > 0) {
      const rows = data as CodeChunk[];
      if (partPrefix) {
        const filtered = rows.filter((r) => (r.section_id ?? '').startsWith(partPrefix));
        if (filtered.length > 0) return filtered.slice(0, matchCount);
      }
      return rows.slice(0, matchCount);
    }
  }

  // Vector path returned nothing (empty DB, low similarity, or embed error).
  return keywordFallback(query, matchCount, partPrefix);
}

export async function countCodeChunks(): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('building_code_chunks')
    .select('id', { count: 'exact', head: true });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[retrieve] count chunks failed', error);
    return -1;
  }
  return count ?? 0;
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
