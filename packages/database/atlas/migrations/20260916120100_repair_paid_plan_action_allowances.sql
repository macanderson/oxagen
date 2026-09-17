-- Repair paid plan rows still sitting on the free-tier action allowance.
--
-- `billing.plans.included_actions_annual` is NOT NULL DEFAULT 25000 — the FREE
-- figure — and `tools/scripts/stripe-sync.ts` did not write the column, so every
-- paid plan row that script CREATED landed on 25,000: one fifteenth of Scale's
-- allowance, on the primary meter under ADR-052. The 2026-09-11 migration's
-- backfill could not catch these, because they are created after it runs.
--
-- The predicate is deliberately narrow. It repairs only a NON-FREE row still
-- holding exactly the free default, which is unambiguously the missing INSERT
-- value rather than a decision: a build or scale plan's allowance is published,
-- not negotiated, so 25,000 on one of them can only be this bug. An enterprise
-- row lands on the scale figure for the same reason the 2026-09-11 migration
-- gave — an unset commitment must read as neither unlimited nor free — and a
-- signed figure already written to the row is left alone, because it is not
-- 25,000.
UPDATE billing.plans SET included_actions_annual = 250000
 WHERE tier = 'build'      AND included_actions_annual = 25000;
UPDATE billing.plans SET included_actions_annual = 1500000
 WHERE tier = 'scale'      AND included_actions_annual = 25000;
UPDATE billing.plans SET included_actions_annual = 1500000
 WHERE tier = 'enterprise' AND included_actions_annual = 25000;
