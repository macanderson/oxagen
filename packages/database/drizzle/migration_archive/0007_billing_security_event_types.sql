-- 0007_billing_security_event_types.sql
--
-- SOC2 CC6.3/CC6.8: Add billing.* event types to the security_events
-- event_type CHECK constraint so that the DB layer rejects unknown values
-- even if application code drifts.
--
-- Background
-- ----------
-- The CHECK constraint was created in 0002_security_events_partitioning.sql.
-- Postgres does not support ALTER TABLE ... ALTER CONSTRAINT, so the only
-- path is DROP + ADD. The parent table is RANGE-partitioned; Postgres
-- propagates CHECK constraints to all child partitions, so the DROP/ADD on
-- the parent is sufficient — no per-partition DDL is required.
--
-- Idempotency
-- -----------
-- DROP CONSTRAINT IF EXISTS is safe to re-run. The ADD CONSTRAINT is also
-- safe because IF NOT EXISTS is not needed here — the DROP ensures it is
-- gone before we add it back. Re-running this migration on a DB where it has
-- already been applied will succeed (the constraint will simply be absent
-- after the DROP and re-created by the ADD).
--
-- Value list
-- ----------
-- The full set of accepted event_type values, kept in lexicographic order
-- within each group, mirrors the SECURITY_EVENT_TYPES array in
-- packages/database/src/schema/security.ts and
-- packages/telemetry/src/security.ts. Any drift between those three sources
-- (TS, migration SQL, running DB) is a SOC2 finding.
--
-- Groups (in order):
--   auth.*           — Auth lifecycle
--   api_key.*        — API key lifecycle
--   billing.*        — Billing mutations (NEW in this migration)
--   capability.*     — Capability authz
--   org.*            — Org management

ALTER TABLE security.security_events
  DROP CONSTRAINT IF EXISTS security_events_event_type_check;

ALTER TABLE security.security_events
  ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN (
    -- Auth lifecycle
    'auth.sign_in',
    'auth.sign_in_failed',
    'auth.sign_out',
    'auth.token_refreshed',
    'auth.password_changed',
    'auth.email_verified',
    -- API key lifecycle
    'api_key.created',
    'api_key.revoked',
    'api_key.used',
    -- Billing mutations
    'billing.access_denied',
    'billing.auto_reload_updated',
    'billing.credits_purchased',
    'billing.payment_method_added',
    'billing.payment_method_default_changed',
    'billing.payment_method_removed',
    'billing.plan_changed',
    'billing.seats_changed',
    'billing.subscription_canceled',
    'billing.subscription_reactivated',
    -- Capability authz
    'capability.invoke_allowed',
    'capability.invoke_denied',
    'capability.invoke_error',
    -- Admin / org management
    'org.member_invited',
    'org.member_removed',
    'org.role_changed'
  ));
