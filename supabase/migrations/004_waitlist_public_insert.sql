-- The new sb_publishable_* keys don't always resolve to the legacy `anon`
-- role for policy matching. Re-create the waitlist insert policy targeting
-- `public` so any unauthenticated visitor can sign up. Read access stays
-- locked down (no select policy = no reads).

drop policy if exists waitlist_anon_insert on waitlist;

create policy waitlist_public_insert on waitlist
  for insert
  to public
  with check (true);
