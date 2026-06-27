-- Agent Environments & Credential Vault — Phase 0 (Spec §5).
--
-- Creates the environments Postgres schema and four tables:
--   §5.1  environments       (env_…) — one is_default per workspace; seeded "default"
--   §5.4  secret_keys        (sk_…)  — vault root: key + sensitive flag + default value
--   §5.5  secret_values      (sv_…)  — per-(key, environment) overrides
--   §5.7  secret_access_log           — append-only audit for reveal/export (§7.3)
--
-- Sandbox templates / agent bindings / network agents (§5.2–§5.3, §5.6, §5.8)
-- land with their owning tickets so nothing ships as dead schema.
--
-- Notes:
--   - No cross-schema FK .references() to avoid circular deps; app-enforced FKs.
--   - Partial unique indexes (WHERE …) are canonical here, not in Drizzle.
--   - RLS follows the tenant_isolation pattern from 20260612140000.
--   - oxagen_app grants mirror the schema_registry block (20260623120000) for
--     environments replaying in order before any future regrant loop.

-- ── Schema ────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS "environments";

-- ── §5.1 environments.environments ───────────────────────────────────────────
CREATE TABLE "environments"."environments" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "description" text NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "environments_public_id_unique" UNIQUE ("public_id")
);
CREATE INDEX "environments_org_workspace_idx"
  ON "environments"."environments" ("org_id", "workspace_id");
-- One live environment per (workspace, slug).
CREATE UNIQUE INDEX "environments_workspace_slug_uniq"
  ON "environments"."environments" ("workspace_id", "slug")
  WHERE (deleted_at IS NULL);
-- Exactly one default environment per workspace (the only-one-default invariant).
CREATE UNIQUE INDEX "environments_workspace_default_uniq"
  ON "environments"."environments" ("workspace_id")
  WHERE (is_default AND deleted_at IS NULL);

-- ── §5.4 environments.secret_keys ────────────────────────────────────────────
CREATE TABLE "environments"."secret_keys" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  -- Env-var name. Validated ^[A-Za-z_][A-Za-z0-9_]*$ at the service layer.
  "key" text NOT NULL,
  "sensitive" boolean NOT NULL DEFAULT true,
  "memo" text NULL,
  -- Default value (used when an environment has no override). Encrypted when
  -- sensitive; plaintext when not. Both null = no default.
  "default_value_enc" bytea NULL,
  "default_value_text" text NULL,
  "default_value_kms_key_id" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "secret_keys_public_id_unique" UNIQUE ("public_id"),
  -- Sensitive keys store only ciphertext; non-sensitive keys store only text.
  CONSTRAINT "secret_keys_default_storage_check"
    CHECK ((sensitive AND default_value_text IS NULL) OR (NOT sensitive AND default_value_enc IS NULL))
);
CREATE INDEX "secret_keys_org_workspace_idx"
  ON "environments"."secret_keys" ("org_id", "workspace_id");
-- One live key per (workspace, key).
CREATE UNIQUE INDEX "secret_keys_workspace_key_uniq"
  ON "environments"."secret_keys" ("workspace_id", "key")
  WHERE (deleted_at IS NULL);

-- ── §5.5 environments.secret_values ──────────────────────────────────────────
CREATE TABLE "environments"."secret_values" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  -- App-enforced FKs to secret_keys.id / environments.id.
  "secret_key_id" uuid NOT NULL,
  "environment_id" uuid NOT NULL,
  "value_enc" bytea NULL,
  "value_text" text NULL,
  "value_kms_key_id" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "secret_values_public_id_unique" UNIQUE ("public_id"),
  -- One override per (key, environment).
  CONSTRAINT "secret_values_key_env_uniq" UNIQUE ("secret_key_id", "environment_id"),
  -- Never both ciphertext and plaintext on one override.
  CONSTRAINT "secret_values_storage_check"
    CHECK (NOT (value_enc IS NOT NULL AND value_text IS NOT NULL))
);
CREATE INDEX "secret_values_environment_idx"
  ON "environments"."secret_values" ("environment_id");
CREATE INDEX "secret_values_org_workspace_idx"
  ON "environments"."secret_values" ("org_id", "workspace_id");

-- ── §5.7 environments.secret_access_log ──────────────────────────────────────
-- Append-only audit of every plaintext reveal/export. No soft delete, no audit
-- mixin — the row IS the record.
CREATE TABLE "environments"."secret_access_log" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "actor_user_id" uuid NULL,
  "action" text NOT NULL,
  "scope" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "request_id" text NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "secret_access_log_action_check" CHECK (action IN ('reveal', 'export'))
);
CREATE INDEX "secret_access_log_org_workspace_idx"
  ON "environments"."secret_access_log" ("org_id", "workspace_id");
CREATE INDEX "secret_access_log_occurred_at_idx"
  ON "environments"."secret_access_log" ("occurred_at");

-- ── §14 RLS — tenant_isolation on all four environments tables ────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.

ALTER TABLE environments.environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.environments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON environments.environments;
CREATE POLICY tenant_isolation ON environments.environments
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE environments.secret_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.secret_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON environments.secret_keys;
CREATE POLICY tenant_isolation ON environments.secret_keys
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE environments.secret_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.secret_values FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON environments.secret_values;
CREATE POLICY tenant_isolation ON environments.secret_values
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE environments.secret_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.secret_access_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON environments.secret_access_log;
CREATE POLICY tenant_isolation ON environments.secret_access_log
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants for environments ───────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA environments TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA environments TO oxagen_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA environments TO oxagen_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA environments GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA environments GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app';
  END IF;
END
$$;
