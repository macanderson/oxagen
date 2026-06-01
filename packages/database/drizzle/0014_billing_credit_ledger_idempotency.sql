-- 0014_billing_credit_ledger_idempotency.sql
--
-- OXA-1509: Add the UNIQUE constraint that makes credit-grant idempotency
-- atomic. packages/billing/src/grants.ts deposits credits with
-- INSERT … ON CONFLICT DO NOTHING on credit_ledger, but without a matching
-- unique index there is nothing to conflict on — every insert succeeds and
-- concurrent webhook retries (Stripe at-least-once delivery) double-grant.
--
-- Partial index: only grant rows carry (reference_type, reference_id). Spend
-- and other ledger rows leave them NULL and must remain unconstrained — a
-- plain unique index would also be a no-op for them, since SQL treats every
-- NULL as distinct.

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_grant_idempotency_idx
  ON billing.credit_ledger (org_id, reason, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
