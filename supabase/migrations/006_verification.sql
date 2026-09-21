-- Outcome of the TypeSafe (Jev) verification gate for model-authored findings.
-- See lib/verify.ts. Holds the verdict plus the probabilities behind it, so a
-- finding shown to a reviewer can always be traced back to why it survived.
-- Rule-engine findings are arithmetic and never verified this way, so the
-- column stays null for them. Nullable + default null keeps existing rows valid.
alter table violations add column verification jsonb;
