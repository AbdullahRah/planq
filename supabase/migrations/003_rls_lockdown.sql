-- Lock down all app tables: server (service_role) writes via supabaseAdmin in
-- app/api/analyze/route.ts and lib/ingest-core.ts. The anon key should not
-- read any user data or insert into operational tables. service_role bypasses
-- RLS, so enabling RLS with no policies means: only server can read/write.

alter table plans enable row level security;
alter table plan_sheets enable row level security;
alter table violations enable row level security;
alter table building_code_chunks enable row level security;
alter table waitlist enable row level security;

-- Public waitlist sign-up: anon may insert their own row, but cannot read the
-- list. Marketing site posts directly to Supabase with the anon key; auditing
-- and read-back happens server-side with service_role.
create policy waitlist_anon_insert on waitlist
  for insert
  to anon, authenticated
  with check (true);
