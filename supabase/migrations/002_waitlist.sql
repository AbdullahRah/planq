create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  source text default 'website',
  role text,
  company text,
  created_at timestamptz default now()
);

create index if not exists waitlist_created_at_idx on waitlist (created_at desc);
