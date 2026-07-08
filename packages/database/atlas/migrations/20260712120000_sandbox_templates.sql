-- Sandbox Templates + Portable Template Artifacts — Phase 1 (Spec §5.2–§5.3, §5.6, §19).
--
-- Adds three tables to the existing environments schema:
--   §5.2  sandbox_templates          (sbx_…) — portable sandbox config; one is_default per (workspace, environment)
--   §5.3  sandbox_template_tools     (sbt_…) — preloaded tools for a template (replace-set)
--   §5.6  agent_environment_bindings (aeb_…) — agent → (environment, template); one is_primary per agent
--
-- Notes:
--   - No cross-schema FK .references() to avoid circular deps; app-enforced FKs.
--   - Partial unique indexes (WHERE …) are canonical here, not in Drizzle.
--   - RLS follows the tenant_isolation pattern from 20260626120000 exactly.
--   - oxagen_app grants mirror the environments Phase 0 block so replays before
--     any future regrant loop still see the new tables granted.

-- ── §5.2 environments.sandbox_templates ──────────────────────────────────────
CREATE TABLE "environments"."sandbox_templates" (
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
  -- App-enforced FK to environments.id.
  "environment_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "description" text NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  -- 'modal' | 'vercel' | 'docker'. Validated in zod (not a DB enum — extensible).
  "provider" text NOT NULL DEFAULT 'modal',
  -- Image ref (digest-pinned encouraged) or language tag; null = driver default.
  "runtime" text NULL,
  "resources" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "network" jsonb NOT NULL DEFAULT '{"mode":"public"}'::jsonb,
  "secret_selection" jsonb NOT NULL DEFAULT '"all"'::jsonb,
  "literal_env" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("id"),
  CONSTRAINT "sandbox_templates_public_id_unique" UNIQUE ("public_id")
);
CREATE INDEX "sandbox_templates_org_workspace_idx"
  ON "environments"."sandbox_templates" ("org_id", "workspace_id");
CREATE INDEX "sandbox_templates_environment_idx"
  ON "environments"."sandbox_templates" ("environment_id");
-- One live template per (workspace, slug).
CREATE UNIQUE INDEX "sandbox_templates_workspace_slug_uniq"
  ON "environments"."sandbox_templates" ("workspace_id", "slug")
  WHERE (deleted_at IS NULL);
-- Exactly one default template per (workspace, environment).
CREATE UNIQUE INDEX "sandbox_templates_workspace_env_default_uniq"
  ON "environments"."sandbox_templates" ("workspace_id", "environment_id")
  WHERE (is_default AND deleted_at IS NULL);

-- ── §5.3 environments.sandbox_template_tools ─────────────────────────────────
CREATE TABLE "environments"."sandbox_template_tools" (
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
  -- App-enforced FK to sandbox_templates.id.
  "sandbox_template_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "ref" text NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("id"),
  CONSTRAINT "sandbox_template_tools_public_id_unique" UNIQUE ("public_id"),
  -- One row per (template, kind, ref).
  CONSTRAINT "sandbox_template_tools_template_kind_ref_uniq"
    UNIQUE ("sandbox_template_id", "kind", "ref"),
  CONSTRAINT "sandbox_template_tools_kind_check"
    CHECK (kind IN ('capability', 'mcp_server', 'agent_skill', 'tool'))
);
CREATE INDEX "sandbox_template_tools_template_idx"
  ON "environments"."sandbox_template_tools" ("sandbox_template_id");
CREATE INDEX "sandbox_template_tools_org_workspace_idx"
  ON "environments"."sandbox_template_tools" ("org_id", "workspace_id");

-- ── §5.6 environments.agent_environment_bindings ─────────────────────────────
CREATE TABLE "environments"."agent_environment_bindings" (
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
  -- App-enforced FKs to agent.agents.id / environments.id / sandbox_templates.id.
  "agent_id" uuid NOT NULL,
  "environment_id" uuid NOT NULL,
  "sandbox_template_id" uuid NULL,
  "is_primary" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_environment_bindings_public_id_unique" UNIQUE ("public_id"),
  -- One binding per (agent, environment).
  CONSTRAINT "agent_environment_bindings_agent_env_uniq"
    UNIQUE ("agent_id", "environment_id")
);
CREATE INDEX "agent_environment_bindings_agent_idx"
  ON "environments"."agent_environment_bindings" ("agent_id");
CREATE INDEX "agent_environment_bindings_org_workspace_idx"
  ON "environments"."agent_environment_bindings" ("org_id", "workspace_id");
-- Exactly one primary binding per agent.
CREATE UNIQUE INDEX "agent_environment_bindings_agent_primary_uniq"
  ON "environments"."agent_environment_bindings" ("agent_id")
  WHERE (is_primary);

-- ── §14 RLS — tenant_isolation on all three tables ───────────────────────────
-- Pattern matches 20260626120000_environments_vault.sql exactly.

ALTER TABLE environments.sandbox_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.sandbox_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON environments.sandbox_templates;
CREATE POLICY tenant_isolation ON environments.sandbox_templates
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE environments.sandbox_template_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.sandbox_template_tools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON environments.sandbox_template_tools;
CREATE POLICY tenant_isolation ON environments.sandbox_template_tools
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE environments.agent_environment_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.agent_environment_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON environments.agent_environment_bindings;
CREATE POLICY tenant_isolation ON environments.agent_environment_bindings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants for the new environments tables ────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON environments.sandbox_templates TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON environments.sandbox_template_tools TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON environments.agent_environment_bindings TO oxagen_app';
  END IF;
END
$$;
