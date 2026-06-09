-- Migration 0033: GDPR Art.17/20 privacy request tables
-- privacy_export_requests: tracks Art.20 data portability requests
-- privacy_erasure_requests: tracks Art.17 right-to-erasure requests
-- Both live in the auth schema alongside users.
-- Also adds the three privacy security event types to the CHECK constraint.

-- ── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE auth.privacy_request_scope AS ENUM ('user', 'org');
CREATE TYPE auth.privacy_export_status AS ENUM ('queued', 'processing', 'ready', 'failed');
CREATE TYPE auth.privacy_erasure_status AS ENUM ('queued', 'processing', 'completed', 'failed');

-- ── privacy_export_requests ─────────────────────────────────────────────────

CREATE TABLE auth.privacy_export_requests (
  id                UUID        NOT NULL DEFAULT COALESCE(
                                  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                    THEN uuid_generate_v7()
                                    ELSE uuid_generate_v4()
                                  END,
                                  uuid_generate_v4()
                                ),
  public_id         CITEXT      NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id           UUID        NOT NULL,
  org_id            UUID        NOT NULL,
  scope             auth.privacy_request_scope NOT NULL,
  status            auth.privacy_export_status NOT NULL DEFAULT 'queued',
  export_url        TEXT,
  completed_at      TIMESTAMPTZ,
  error_message     TEXT,
  PRIMARY KEY (id),
  CONSTRAINT privacy_export_status_chk CHECK (status IN ('queued','processing','ready','failed'))
);

CREATE INDEX privacy_export_requests_user_idx ON auth.privacy_export_requests (user_id);
CREATE INDEX privacy_export_requests_org_idx  ON auth.privacy_export_requests (org_id);

-- ── privacy_erasure_requests ────────────────────────────────────────────────

CREATE TABLE auth.privacy_erasure_requests (
  id                UUID        NOT NULL DEFAULT COALESCE(
                                  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                    THEN uuid_generate_v7()
                                    ELSE uuid_generate_v4()
                                  END,
                                  uuid_generate_v4()
                                ),
  public_id         CITEXT      NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id           UUID        NOT NULL,
  org_id            UUID        NOT NULL,
  scope             auth.privacy_request_scope NOT NULL,
  status            auth.privacy_erasure_status NOT NULL DEFAULT 'queued',
  scheduled_at      TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  error_message     TEXT,
  PRIMARY KEY (id),
  CONSTRAINT privacy_erasure_status_chk CHECK (status IN ('queued','processing','completed','failed'))
);

CREATE INDEX privacy_erasure_requests_user_idx ON auth.privacy_erasure_requests (user_id);
CREATE INDEX privacy_erasure_requests_org_idx  ON auth.privacy_erasure_requests (org_id);

-- ── Security event types: add privacy events to CHECK constraint ────────────
-- The CHECK constraint on security.security_events is generated from
-- @oxagen/compliance security-event-types.ts. Re-drop and recreate it.

ALTER TABLE security.security_events
  DROP CONSTRAINT IF EXISTS security_events_event_type_chk;

ALTER TABLE security.security_events
  ADD CONSTRAINT security_events_event_type_chk CHECK (
    event_type IN (
      'auth.sign_in','auth.sign_in_failed','auth.sign_out',
      'auth.token_refreshed','auth.password_changed','auth.email_verified',
      'api_key.created','api_key.revoked','api_key.used',
      'billing.access_denied','billing.auto_reload_updated',
      'billing.checkout_initiated','billing.credits_purchased',
      'billing.payment_method_added','billing.payment_method_default_changed',
      'billing.payment_method_removed','billing.plan_changed',
      'billing.seats_changed','billing.subscription_canceled',
      'billing.subscription_reactivated',
      'capability.invoke_allowed','capability.invoke_denied','capability.invoke_error',
      'organization.created','workspace.created',
      'org.member_invited','org.member_removed','org.role_changed',
      'security.mfa_policy_updated','security.session_revoked',
      'access.review_completed','access.member_access_confirmed',
      'privacy.export_requested','privacy.erasure_requested','privacy.org_erasure_requested'
    )
  );
