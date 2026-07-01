-- 0017_memory_changes_enforcement.sql
--
-- Two-axis memory model: add enforcement_before / enforcement_after to
-- memory_changes so a change row can audit an enforcement_score move
-- (policy axis) alongside the existing confidence_before/after (evidence
-- axis). See docs/specs/two-axis-memory/DESIGN.md "ClickHouse audit".
--
-- Decay-pass rows leave enforcement unchanged (0/0 — enforcement never
-- auto-decays); future promote/cite/evidence-attach writers stamp the real
-- before/after enforcement values. ADD COLUMN IF NOT EXISTS: idempotent,
-- safe on any replica set.

ALTER TABLE memory_changes
    ADD COLUMN IF NOT EXISTS enforcement_before Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS enforcement_after  Float32 DEFAULT 0;
