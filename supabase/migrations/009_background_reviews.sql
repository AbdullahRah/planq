-- Reviews run in the background (workflows/review.ts).
--
-- A review used to be one request that had to finish inside a 300 s function.
-- A 26-sheet set could not: it either returned a 504 or skipped sheets and the
-- independent check. Now the upload starts a durable workflow and returns at
-- once, and the page polls the plan row for progress and, at the end, the
-- result. These columns are what it polls.

-- The durable run, so a stuck review can be inspected or cancelled.
alter table plans add column if not exists workflow_run_id text;
-- {"stage": "S2", "detail": "...", "done": 8, "total": 26}, rewritten as the run advances.
alter table plans add column if not exists progress jsonb;
-- The finished review exactly as the page renders it.
alter table plans add column if not exists result jsonb;
-- Why a run failed, when it did.
alter table plans add column if not exists error text;
alter table plans add column if not exists updated_at timestamptz not null default now();
