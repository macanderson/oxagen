-- WL-27: retire the annual governed-action meter.
--
-- ADR-055 replaced the annual, dollar-denominated meter with the monthly GAU
-- bucket (billing.gau_buckets, 20260914165423_gau_buckets_and_contract_terms.sql).
-- The recorder debits the bucket, the gate reads it, and get_gau_bucket reports
-- it. Nothing reads the annual counter or the annual plan allowance any more:
-- get_action_usage, incrementActionCounter and readActionCounter are deleted in
-- the same change, and resolveOrgActionEntitlement now derives its annual figure
-- as included_gau_per_month * 12 from the plan row.
--
--   1. billing.governed_action_counters is dropped with its RLS policy and
--      unique index (both go with the table).
--   2. billing.plans.included_actions_annual is dropped with the CHECK
--      constraint 20260911120000_governed_action_meter.sql added for it.
--
-- Data: the counter rows are a per-year running total of an allowance nothing
-- enforces now. Each organisation's position against its terms is the month's
-- gau_buckets row, which the recorder has been writing since WL-25, so there is
-- nothing in the counter to carry forward.

-- ── 1. The annual counter ────────────────────────────────────────────────────
DROP TABLE IF EXISTS billing.governed_action_counters;

-- ── 2. The annual plan allowance ─────────────────────────────────────────────
ALTER TABLE billing.plans
  DROP CONSTRAINT IF EXISTS plans_included_actions_non_negative;

ALTER TABLE billing.plans
  DROP COLUMN IF EXISTS included_actions_annual;
