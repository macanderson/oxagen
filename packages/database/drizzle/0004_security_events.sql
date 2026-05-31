-- 0004_security_events.sql
--
-- SOC2 CC6/CC7 compliance: append-only audit surface for every security-
-- relevant event (auth lifecycle, capability authz, API key usage, org
-- management).
--
-- COMPLIANCE RULES (immutable — do not add mutation columns):
--   - No updated_at / updated_by / deleted_at / deleted_by.
--   - Rows are written once; the audit trail is forensic evidence.
--   - The `security` Postgres schema has tighter ACL than operational
--     schemas: app role has INSERT only; no UPDATE or DELETE.
--
-- Down migration (documented, not run):
--   DROP TABLE security.security_events;
--   DROP SCHEMA security;

CREATE SCHEMA IF NOT EXISTS "security";

-- Revoke default public access; grant narrowest needed privileges to the
-- application role. Adjust `oxagen_app` to match your actual Postgres role.
-- (REVOKE/GRANT are advisory at migration time — adjust to your env.)
-- REVOKE ALL ON SCHEMA security FROM PUBLIC;
-- GRANT USAGE ON SCHEMA security TO oxagen_app;

CREATE TABLE IF NOT EXISTS "security"."security_events" (
  "id"           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- occurred_at: when the event happened. Caller-supplied for accurate
  -- timestamps even when emitted near a transaction boundary.
  "occurred_at"  timestamptz NOT NULL DEFAULT now(),
  -- event_type: typed const-union enforced by CHECK constraint so the DB
  -- rejects unknown values even if application code drifts.
  "event_type"   text        NOT NULL,
  -- actor: nullable — some events fire before a session exists (e.g. failed
  -- sign-in with an unknown email).
  "actor_user_id" uuid,
  -- scope: org always required; workspace nullable for org-level events.
  "org_id"       uuid        NOT NULL,
  "workspace_id" uuid,
  -- Which capability was invoked (null for non-capability events).
  "capability"   text,
  -- Authz outcome.
  "outcome"      text        NOT NULL,
  -- Request metadata — forensics only; NEVER store tokens, passwords, PII.
  "ip"           text,
  "user_agent"   text,
  "request_id"   text,

  CONSTRAINT "security_events_event_type_check" CHECK (
    "event_type" IN (
      'auth.sign_in',
      'auth.sign_in_failed',
      'auth.sign_out',
      'auth.token_refreshed',
      'auth.password_changed',
      'auth.email_verified',
      'api_key.created',
      'api_key.revoked',
      'api_key.used',
      'capability.invoke_allowed',
      'capability.invoke_denied',
      'capability.invoke_error',
      'org.member_invited',
      'org.member_removed',
      'org.role_changed'
    )
  ),

  CONSTRAINT "security_events_outcome_check" CHECK (
    "outcome" IN ('allow', 'deny', 'error', 'success')
  )
);

-- Compliance range queries: "all events for org X between date A and B"
CREATE INDEX IF NOT EXISTS "security_events_org_occurred_idx"
  ON "security"."security_events" ("org_id", "occurred_at");

-- Alert queries: "all denied invocations in the last hour"
CREATE INDEX IF NOT EXISTS "security_events_type_occurred_idx"
  ON "security"."security_events" ("event_type", "occurred_at");
