-- Repair paid plan rows still sitting on the free-tier action allowance.
--
-- `billing.plans.included_actions_annual` was NOT NULL DEFAULT 25000 — the FREE
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
--
-- Guarded on the column's existence. `20260915120000_drop_governed_action_counters`
-- drops `included_actions_annual` when the Mission Control rebuild lands, and this
-- file carries a later timestamp, so on any database that has taken the drop the
-- UPDATEs below would fail on a column that is gone. The rows this repairs no
-- longer exist there — the published allowance is `included_gau_per_month` — so
-- the correct behaviour post-drop is to do nothing, not to error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'billing'
       AND table_name   = 'plans'
       AND column_name  = 'included_actions_annual'
  ) THEN
    UPDATE billing.plans SET included_actions_annual = 250000
     WHERE tier = 'build'      AND included_actions_annual = 25000;
    UPDATE billing.plans SET included_actions_annual = 1500000
     WHERE tier = 'scale'      AND included_actions_annual = 25000;
    UPDATE billing.plans SET included_actions_annual = 1500000
     WHERE tier = 'enterprise' AND included_actions_annual = 25000;
  END IF;
END $$;
