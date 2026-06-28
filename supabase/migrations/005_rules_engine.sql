-- Deterministic rule engine. code_rules holds Part 9 dimensional requirements
-- evaluated arithmetically against extracted plan measurements (no embeddings).
-- Rules are looked up by element_type + conditions; see lib/rule-engine/.

create table code_rules (
  id text primary key,                       -- "nbc-9.8.4.2-run"
  section text not null,                      -- "9.8.4.2"
  title text,
  part text,                                  -- "9"
  jurisdiction text default 'NBC_Alberta_2019',
  element_type text not null,                 -- stair|door|corridor|room|egress|guard
  attribute text not null,                    -- run_depth_mm | width_mm | ...
  operator text not null check (operator in ('gte', 'lte', 'eq', 'between')),
  value numeric not null,
  value_max numeric,                          -- upper bound for 'between'
  conditions jsonb default '{}'::jsonb,       -- { occupancy_type, building_part }
  severity text not null check (severity in ('critical', 'major', 'minor')),
  message text not null,                      -- supports {value} {min} {max} placeholders
  created_at timestamptz default now()
);

create index on code_rules (element_type);

-- Server-only access, consistent with 003_rls_lockdown.sql: enabling RLS with no
-- policies means only service_role (which bypasses RLS) can read/write.
alter table code_rules enable row level security;

-- Distinguish deterministic findings from LLM findings for dedupe + UI badging.
-- Nullable + default null keeps existing rows valid.
alter table violations add column source text;
