-- Drop index "credit_ledger_grant_idempotency_idx" from table: "credit_ledger"
DROP INDEX "billing"."credit_ledger_grant_idempotency_idx";
-- Create index "credit_ledger_grant_idempotency_idx" to table: "credit_ledger"
CREATE UNIQUE INDEX "credit_ledger_grant_idempotency_idx" ON "billing"."credit_ledger" ("org_id", "reason", "reference_type", "reference_id") WHERE ((reference_type IS NOT NULL) AND (reference_id IS NOT NULL) AND (reason ~~ 'grant_%'::text));
