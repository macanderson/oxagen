-- Enterprise SSO behind Better Auth's @better-auth/sso plugin (ADR-145).
--
-- 1. auth.sso_providers: one row per OIDC or SAML identity provider an
--    organisation registers. The plugin reads it as its "ssoProvider" model.
--    Secrets inside oidc_config and saml_config are envelope-encrypted tokens,
--    never plaintext (@oxagen/database/sso-secrets). No RLS, like every Better
--    Auth table: the sign-in request that reads it has no tenant scope yet.
-- 2. org.sso_group_roles: the IdP group → org role table the Roles page edits.
--    Deny by default: an unmapped group grants nothing. Owner is not mappable.
--    org_only RLS.
-- 3. security.org_security_policy.sso_required: the org's "require SSO" switch.
-- 4. auth.sessions.auth_method: how a session was established, so the org gate
--    can tell an SSO session from a password one.
-- 5. security_events_event_type_check: widened by the seven sso.* types. The
--    body is the output of generateEventTypeCheckClause() in
--    packages/compliance/src/db-check.ts.
--
-- Hand-written, then `atlas migrate hash`, because `atlas migrate diff` is
-- broken by the pg_trgm fresh-replay defect
-- (docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md).
--
-- Rollback:
--   DROP TABLE IF EXISTS org.sso_group_roles;
--   DROP TABLE IF EXISTS auth.sso_providers;
--   ALTER TABLE security.org_security_policy DROP COLUMN IF EXISTS sso_required;
--   ALTER TABLE auth.sessions DROP COLUMN IF EXISTS auth_method;
--   (re-add the previous event_type CHECK from 20260921110000)

CREATE TABLE IF NOT EXISTS "auth"."sso_providers" (
  "id" text NOT NULL,
  "issuer" text NOT NULL,
  "oidc_config" text NULL,
  "saml_config" text NULL,
  "user_id" uuid NULL,
  "provider_id" text NOT NULL,
  "organization_id" uuid NOT NULL,
  "domain" text NOT NULL,
  "domain_verified" boolean NOT NULL DEFAULT false,
  "protocol" text NOT NULL,
  "display_name" text NOT NULL,
  "groups_claim" text NOT NULL DEFAULT 'groups',
  "domain_verification_token" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "sso_providers_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "org"."organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "sso_providers_protocol_check"
    CHECK ("protocol" IN ('oidc', 'saml')),
  CONSTRAINT "sso_providers_config_check"
    CHECK (("protocol" = 'oidc' AND "oidc_config" IS NOT NULL AND "saml_config" IS NULL)
        OR ("protocol" = 'saml' AND "saml_config" IS NOT NULL AND "oidc_config" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "sso_providers_provider_id_idx"
  ON "auth"."sso_providers" ("provider_id");
-- One organisation per email domain.
CREATE UNIQUE INDEX IF NOT EXISTS "sso_providers_domain_idx"
  ON "auth"."sso_providers" ("domain");
CREATE INDEX IF NOT EXISTS "sso_providers_organization_id_idx"
  ON "auth"."sso_providers" ("organization_id");

CREATE TABLE IF NOT EXISTS "org"."sso_group_roles" (
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
  "provider_id" text NOT NULL,
  "idp_group" text NOT NULL,
  "role" text NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "sso_group_roles_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "sso_group_roles_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  CONSTRAINT "sso_group_roles_provider_id_sso_providers_provider_id_fk"
    FOREIGN KEY ("provider_id") REFERENCES "auth"."sso_providers" ("provider_id") ON DELETE CASCADE,
  CONSTRAINT "sso_group_roles_role_check"
    CHECK ("role" IN ('admin', 'compliance', 'billing', 'member'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "sso_group_roles_provider_group_idx"
  ON "org"."sso_group_roles" ("provider_id", "idp_group");
CREATE INDEX IF NOT EXISTS "sso_group_roles_org_idx"
  ON "org"."sso_group_roles" ("org_id");

-- RLS: org_only, as tools/scripts/gen-rls-migration.ts emits it.
ALTER TABLE org.sso_group_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.sso_group_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.sso_group_roles;
DROP POLICY IF EXISTS tenant_org_wide_read ON org.sso_group_roles;
CREATE POLICY tenant_isolation ON org.sso_group_roles
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE security.org_security_policy
  ADD COLUMN IF NOT EXISTS sso_required boolean NOT NULL DEFAULT false;

ALTER TABLE auth.sessions
  ADD COLUMN IF NOT EXISTS auth_method text NULL;

ALTER TABLE security.security_events DROP CONSTRAINT security_events_event_type_check;
ALTER TABLE security.security_events ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.budget_updated', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'workspace.archived', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'iam.role_created', 'iam.role_grants_set', 'iam.role_deleted', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'plugin.credential_set', 'plugin.credential_revoked', 'secret.revealed', 'secret.exported', 'secret.value_changed', 'secret.key_deleted', 'security.mfa_policy_updated', 'security.session_revoked', 'data_plane.updated', 'model_credential.set', 'model_credential.revoked', 'tool.kill_switch_flipped', 'tool.classification_changed', 'agent.registered', 'agent.suspended', 'agent.resumed', 'agent.retired', 'evidence.disclosure_grain_changed', 'agent_run.event_sequence_conflict', 'agent_run.forged_decision_reference', 'agent_run.stale_deny_generation', 'agent_run.finalization_grant_misuse', 'mandate.granted', 'mandate.limits_changed', 'mandate.revoked', 'mandate.expired', 'mandate.exception', 'approval.auto_approved', 'approval_rule.changed', 'approval_rule.invalidated', 'approval_rule.deleted', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested', 'steering.published', 'steering.governance_changed', 'steering.governance_overridden', 'sso.provider_created', 'sso.domain_verified', 'sso.provider_updated', 'sso.provider_deleted', 'sso.policy_updated', 'sso.group_roles_set', 'sso.sign_in'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON org.sso_group_roles TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.sso_providers TO oxagen_app;
  END IF;
END
$$;
