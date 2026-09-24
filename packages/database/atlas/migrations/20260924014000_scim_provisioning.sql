-- SCIM 2.0 provisioning and deprovisioning (#3734, ADR-145).
--
-- 1. org.scim_tokens: the bearer token an identity provider pushes users and
--    groups with. SHA-256 only, like auth.api_keys.key_hash. One live token
--    per organization (partial unique index); revoked rows stay as history.
-- 2. org.scim_groups and org.scim_group_members: the groups the identity
--    provider pushed and their members, which is what a group change needs to
--    recompute roles through org.sso_group_roles.
-- 3. security_events_event_type_check: widened by the eight scim.* types and
--    tacho.host_revoked. The body is the output of
--    generateEventTypeCheckClause() in packages/compliance/src/db-check.ts.
--
-- All three tables are org_only RLS, as tools/scripts/gen-rls-migration.ts
-- emits it. Hand-written, then `atlas migrate hash`, for the reason the
-- enterprise SSO migration gives (the pg_trgm fresh-replay defect).
--
-- Rollback:
--   DROP TABLE IF EXISTS org.scim_group_members;
--   DROP TABLE IF EXISTS org.scim_groups;
--   DROP TABLE IF EXISTS org.scim_tokens;
--   (re-add the event_type CHECK from 20260922220000_enterprise_sso.sql)

CREATE TABLE IF NOT EXISTS "org"."scim_tokens" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL)
      THEN public.uuid_generate_v7() ELSE public.uuid_generate_v4() END,
    public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_id" uuid NULL,
  "updated_by_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "token_prefix" text NOT NULL,
  "token_hash" text NOT NULL,
  "last_used_at" timestamptz NULL,
  "revoked_at" timestamptz NULL,
  "revoked_by_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "scim_tokens_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "scim_tokens_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "scim_tokens_token_hash_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "scim_tokens_token_prefix_idx"
  ON "org"."scim_tokens" ("token_prefix");
-- One live token per organization.
CREATE UNIQUE INDEX IF NOT EXISTS "scim_tokens_org_live_idx"
  ON "org"."scim_tokens" ("org_id") WHERE ("revoked_at" IS NULL);

CREATE TABLE IF NOT EXISTS "org"."scim_groups" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL)
      THEN public.uuid_generate_v7() ELSE public.uuid_generate_v4() END,
    public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_id" uuid NULL,
  "updated_by_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "display_name" text NOT NULL,
  "external_id" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "scim_groups_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "scim_groups_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_org_display_name_idx"
  ON "org"."scim_groups" ("org_id", "display_name");
CREATE INDEX IF NOT EXISTS "scim_groups_org_external_id_idx"
  ON "org"."scim_groups" ("org_id", "external_id");

CREATE TABLE IF NOT EXISTS "org"."scim_group_members" (
  "group_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk"
    FOREIGN KEY ("group_id") REFERENCES "org"."scim_groups" ("id") ON DELETE CASCADE,
  CONSTRAINT "scim_group_members_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "scim_group_members_group_user_idx"
  ON "org"."scim_group_members" ("group_id", "user_id");
CREATE INDEX IF NOT EXISTS "scim_group_members_org_user_idx"
  ON "org"."scim_group_members" ("org_id", "user_id");

-- RLS: org_only, as tools/scripts/gen-rls-migration.ts emits it.
ALTER TABLE org.scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.scim_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.scim_tokens;
DROP POLICY IF EXISTS tenant_org_wide_read ON org.scim_tokens;
CREATE POLICY tenant_isolation ON org.scim_tokens
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.scim_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.scim_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.scim_groups;
DROP POLICY IF EXISTS tenant_org_wide_read ON org.scim_groups;
CREATE POLICY tenant_isolation ON org.scim_groups
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.scim_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.scim_group_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.scim_group_members;
DROP POLICY IF EXISTS tenant_org_wide_read ON org.scim_group_members;
CREATE POLICY tenant_isolation ON org.scim_group_members
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE security.security_events DROP CONSTRAINT security_events_event_type_check;
ALTER TABLE security.security_events ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.budget_updated', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'workspace.archived', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'iam.role_created', 'iam.role_grants_set', 'iam.role_deleted', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'plugin.credential_set', 'plugin.credential_revoked', 'secret.revealed', 'secret.exported', 'secret.value_changed', 'secret.key_deleted', 'security.mfa_policy_updated', 'security.session_revoked', 'data_plane.updated', 'model_credential.set', 'model_credential.revoked', 'tool.kill_switch_flipped', 'tool.classification_changed', 'agent.registered', 'agent.suspended', 'agent.resumed', 'agent.retired', 'evidence.disclosure_grain_changed', 'agent_run.event_sequence_conflict', 'agent_run.forged_decision_reference', 'agent_run.stale_deny_generation', 'agent_run.finalization_grant_misuse', 'mandate.granted', 'mandate.limits_changed', 'mandate.revoked', 'mandate.expired', 'mandate.exception', 'approval.auto_approved', 'approval_rule.changed', 'approval_rule.invalidated', 'approval_rule.deleted', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested', 'steering.published', 'steering.governance_changed', 'steering.governance_overridden', 'sso.provider_created', 'sso.domain_verified', 'sso.provider_updated', 'sso.provider_deleted', 'sso.policy_updated', 'sso.group_roles_set', 'sso.sign_in', 'scim.token_created', 'scim.token_rotated', 'scim.token_revoked', 'scim.user_provisioned', 'scim.user_updated', 'scim.user_deprovisioned', 'scim.group_changed', 'scim.request_denied', 'tacho.host_revoked'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON org.scim_tokens TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON org.scim_groups TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON org.scim_group_members TO oxagen_app;
  END IF;
END
$$;
