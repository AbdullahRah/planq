#!/usr/bin/env ts-node
import path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
loadEnv();

async function main() {
  const { createClient } = await import('@supabase/supabase-js');

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishable =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  console.log(`URL: ${url}`);
  console.log(`Publishable: ${publishable.slice(0, 16)}...`);
  console.log(`Service:     ${service.slice(0, 16)}...`);

  const anon = createClient(url, publishable);
  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('\n[1/5] anon: select from plans (should succeed under RLS-off)');
  const a = await anon.from('plans').select('id', { count: 'exact', head: true });
  console.log('   ->', a.error ? `ERROR ${a.error.message}` : `ok (count=${a.count})`);

  console.log('[2/5] admin: select from plans');
  const b = await admin.from('plans').select('id', { count: 'exact', head: true });
  console.log('   ->', b.error ? `ERROR ${b.error.message}` : `ok (count=${b.count})`);

  console.log('[3/5] admin: insert + delete plans row');
  const c = await admin
    .from('plans')
    .insert({ project_name: '__probe__', status: 'pending' })
    .select('id')
    .single();
  if (c.error) {
    console.log('   -> ERROR insert', c.error.message);
  } else {
    console.log(`   -> ok inserted id=${c.data.id}`);
    const d = await admin.from('plans').delete().eq('id', c.data.id);
    console.log(d.error ? `   -> ERROR delete ${d.error.message}` : '   -> ok deleted');
  }

  console.log('[4/5] admin: rpc match_code_chunks (with zero vector)');
  const zeroVec = new Array(1536).fill(0) as number[];
  const e = await admin.rpc('match_code_chunks', {
    query_embedding: zeroVec,
    match_threshold: 0.0,
    match_count: 1,
  });
  console.log(
    e.error ? `   -> ERROR ${e.error.message}` : `   -> ok (rows=${(e.data ?? []).length})`,
  );

  console.log('[5/5] admin: storage bucket "plans" exists');
  const f = await admin.storage.listBuckets();
  if (f.error) {
    console.log('   -> ERROR', f.error.message);
  } else {
    const has = (f.data ?? []).some((b) => b.id === 'plans');
    console.log(has ? '   -> ok found "plans" bucket' : '   -> MISSING "plans" bucket');
  }

  console.log('\nProbe complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
