-- 0023: Update credit_ledger reason check constraint to include all valid reasons
-- The original constraint was missing grant_plan_upgrade, grant_credit_pack,
-- grant_auto_reload, and clawback_dispute, causing silent insert failures.
-- These must match CREDIT_REASONS constant in packages/billing/src/constants.ts

ALTER TABLE billing.credit_ledger
DROP CONSTRAINT credit_ledger_reason_check,
ADD CONSTRAINT credit_ledger_reason_check CHECK (
  reason = ANY (ARRAY[
    'grant_signup'::text,
    'grant_plan_renewal'::text,
    'grant_plan_upgrade'::text,
    'grant_credit_pack'::text,
    'grant_auto_reload'::text,
    'grant_manual'::text,
    'consume_execution'::text,
    'consume_tool_call'::text,
    'consume_token_overage'::text,
    'refund'::text,
    'clawback_dispute'::text,
    'adjustment'::text
  ])
);
