-- 0015_security_policy_and_event_types.sql
--
-- 1. Add security.org_security_policy — org-level MFA enforcement config (CC6.1/CC6.2).
-- 2. Widen security_events.event_type CHECK constraint to include the four new kinds:
--      security.mfa_policy_updated, security.session_revoked,
--      access.review_completed, access.member_access_confirmed
-- 3. Grant the oxagen_app role SELECT/INSERT/UPDATE on the new table.
--
-- Forward migration — immutable after merge (OXA-1515 policy).

-- ── 1. org_security_policy ──────────────────────────────────────────────────

CREATE TABLE security.org_security_policy (
  org_id              uuid        PRIMARY KEY NOT NULL,
  mfa_required        boolean     NOT NULL DEFAULT false,
  mfa_grace_hours     integer     NOT NULL DEFAULT 48,
  updated_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX org_security_policy_org_idx ON security.org_security_policy (org_id);

-- ── 2. Widen the event_type CHECK on security_events ────────────────────────
-- The partitioned parent table holds the CHECK; we drop the old one and
-- add the new wider constraint. Postgres allows ALTER TABLE on the parent of a
-- declarative-partitioned table; the constraint propagates to existing child
-- partitions automatically.

ALTER TABLE security.security_events
  DROP CONSTRAINT IF EXISTS security_events_event_type_check;

ALTER TABLE security.security_events
  ADD CONSTRAINT security_events_event_type_check
  CHECK (event_type IN (
    'auth.sign_in',
    'auth.sign_in_failed',
    'auth.sign_out',
    'auth.token_refreshed',
    'auth.password_changed',
    'auth.email_verified',
    'api_key.created',
    'api_key.revoked',
    'api_key.used',
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
    'capability.invoke_allowed',
    'capability.invoke_denied',
    'capability.invoke_error',
    'org.member_invited',
    'org.member_removed',
    'org.role_changed',
    'security.mfa_policy_updated',
    'security.session_revoked',
    'access.review_completed',
    'access.member_access_confirmed'
  ));

-- ── 3. oxagen_app grants ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON security.org_security_policy TO oxagen_app;
  END IF;
END;
$$;
