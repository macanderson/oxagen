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
--
-- ── Why the column check ─────────────────────────────────────────────────────
--
-- This repair was written on `main`, where the column exists. WL-27 dropped it
-- on `app-rebuild` in 20260915120000_drop_governed_action_counters.sql, which
-- sorts EARLIER than this file: once the two histories are one directory, every
-- replay reaches this statement with the column already gone, and an
-- unconditional UPDATE fails the whole migration with 42703. The two migrations
-- were each correct on their own branch and are in conflict only in the merged
-- order, which is why nothing before the cutover could have caught it.
--
-- So the repair runs where there is something to repair and is a no-op where
-- there is not. A database carrying main's history still gets the exact three
-- UPDATEs below; a fresh replay of the merged history skips them, because by
-- then the annual allowance is not a column any more — the figure is derived as
-- included_gau_per_month * 12 (see resolveOrgActionEntitlement). The statements
-- go through EXECUTE so the planner never resolves a column that is absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'billing'
       AND table_name   = 'plans'
       AND column_name  = 'included_actions_annual'
  ) THEN
    EXECUTE $repair$
      UPDATE billing.plans SET included_actions_annual = 250000
       WHERE tier = 'build'      AND included_actions_annual = 25000;
    $repair$;
    EXECUTE $repair$
      UPDATE billing.plans SET included_actions_annual = 1500000
       WHERE tier = 'scale'      AND included_actions_annual = 25000;
    $repair$;
    EXECUTE $repair$
      UPDATE billing.plans SET included_actions_annual = 1500000
       WHERE tier = 'enterprise' AND included_actions_annual = 25000;
    $repair$;
  END IF;
END
$$;
