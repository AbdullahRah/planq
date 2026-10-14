import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const publishable =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  '';
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export const supabase = createClient(url, publishable);

// Next.js 14 caches fetch() in route handlers by default, and supabase-js
// reads through fetch. The review status route kept answering "S1" for a run
// the database already had as complete. Database reads must never be cached.
const noStore: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-store' });

export const supabaseAdmin = createClient(url, service, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: noStore },
});
