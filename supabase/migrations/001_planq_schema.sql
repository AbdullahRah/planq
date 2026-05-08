create extension if not exists vector;

create table building_code_chunks (
  id uuid primary key default gen_random_uuid(),
  section_id text,
  section_title text,
  content text,
  embedding vector(1536),
  jurisdiction text default 'NBC',
  topic text[],
  created_at timestamptz default now()
);

create index on building_code_chunks
using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create or replace function match_code_chunks(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 10
)
returns table (
  id uuid,
  section_id text,
  section_title text,
  content text,
  similarity float
)
language sql stable as $$
  select
    id, section_id, section_title, content,
    1 - (embedding <=> query_embedding) as similarity
  from building_code_chunks
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;

create table plans (
  id uuid primary key default gen_random_uuid(),
  project_name text,
  status text default 'pending',
  uploaded_at timestamptz default now()
);

create table plan_sheets (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references plans(id) on delete cascade,
  sheet_name text,
  file_type text,
  storage_path text,
  extracted_data jsonb,
  created_at timestamptz default now()
);

create table violations (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references plans(id) on delete cascade,
  type text check (type in ('compliance', 'consistency')),
  severity text check (severity in ('critical', 'major', 'minor')),
  description text,
  section_id text,
  code_citation text,
  affected_sheets text[],
  location_hint text,
  created_at timestamptz default now()
);

insert into storage.buckets (id, name, public) values ('plans', 'plans', false);
