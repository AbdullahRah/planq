#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

(async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { count, error } = await admin
    .from('building_code_chunks')
    .select('id', { count: 'exact', head: true });
  if (error) {
    console.log('count error', error.message);
    return;
  }
  console.log(`building_code_chunks rows: ${count}`);

  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    baseURL: process.env.OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const emb = await client.embeddings.create({
    model: process.env.EMBEDDING_MODEL!,
    input: 'minimum corridor width for public means of egress',
  });
  const vec = emb.data[0]!.embedding as number[];
  const { data, error: rpcErr } = await admin.rpc('match_code_chunks', {
    query_embedding: vec,
    match_threshold: 0.3,
    match_count: 3,
  });
  if (rpcErr) {
    console.log('rpc error', rpcErr.message);
    return;
  }
  console.log(`top-3 matches for "egress corridor width":`);
  for (const r of (data ?? []) as Array<{
    section_id: string;
    section_title: string;
    similarity: number;
    content: string;
  }>) {
    console.log(
      `  [${r.similarity.toFixed(3)}] §${r.section_id} — ${(r.section_title ?? '').slice(0, 60)}`,
    );
    console.log(`     ${(r.content ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
