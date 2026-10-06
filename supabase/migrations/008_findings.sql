-- Findings replace violations (PLANQ_SPEC.md §5).
--
-- A violation carried a three-level severity. A finding carries a five-way
-- status, the clause ids and substring-verified quotes behind it, the fact ids
-- it rests on, the computed comparison, the §S4 verifier verdict and the §G9
-- reviewer state. The old table cannot represent "can't determine", which is
-- the honest answer for most rules on most drawing sets.
--
-- violations is left in place rather than dropped: it holds the history of
-- every review run before this change, and nothing writes to it any more.

create table if not exists findings (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  run_id text not null,
  -- "F1", unique only within a run.
  finding_id text not null,
  rule_id text not null,
  status text not null check (
    status in ('fail', 'needs_confirmation', 'drawing_conflict', 'cant_determine', 'pass')
  ),
  summary text not null,
  clause_ids text[] not null default '{}',
  clause_quotes text[] not null default '{}',
  fact_ids text[] not null default '{}',
  computed jsonb not null default '{}',
  required_action text,
  verifier text not null default 'not_run' check (
    verifier in ('upheld', 'refuted', 'uncertain', 'not_run')
  ),
  verifier_reason text,
  -- §G9: no report is released until a named reviewer approves it, and §G8
  -- reads precision per rule out of these decisions.
  reviewer_state text not null default 'unreviewed' check (
    reviewer_state in ('unreviewed', 'confirmed', 'dismissed')
  ),
  reviewed_by text,
  reviewed_at timestamptz,
  drawing_reference text,
  created_at timestamptz not null default now()
);

create index if not exists findings_plan_idx on findings (plan_id);
create index if not exists findings_run_idx on findings (run_id);
-- Precision per rule (§G8) is confirmed over confirmed plus dismissed, so the
-- reviewer queue is read by rule and by state.
create index if not exists findings_rule_state_idx on findings (rule_id, reviewer_state);

-- §G10: what produced a run, so a finding can always be traced back.
alter table plans add column if not exists run_id text;
alter table plans add column if not exists cost_usd numeric;
alter table plans add column if not exists code_store_hash text;

alter table findings enable row level security;
