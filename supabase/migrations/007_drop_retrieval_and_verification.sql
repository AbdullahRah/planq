-- Retire the embedding-retrieval store and the TypeSafe verification column.
--
-- PLANQ_SPEC.md §2.1 replaces the embedding core with a structured clause store
-- plus a rules engine, and forbids retrieval from ever being the source of a
-- compliance verdict. §S4 replaces the TypeSafe gate with an Opus adversarial
-- verifier whose upheld/refuted/uncertain verdict lands on the Finding record
-- (§5), not on a jsonb column here.
--
-- Forward-only: the clause store arrives in its own migration. Nothing reads
-- building_code_chunks after this (lib/retrieve.ts and lib/verify.ts are gone),
-- so dropping it loses only re-derivable embeddings, not source data.

drop function if exists match_code_chunks(vector, float, int);
drop table if exists building_code_chunks;

-- pgvector is no longer used by any table. Left installed rather than dropped:
-- §2.1 permits retrieval to come back as a "find me related clauses" lookup,
-- and the extension is free to keep while unused.

alter table violations drop column if exists verification;
