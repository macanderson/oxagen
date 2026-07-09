-- auth.workspace_user_preferences — per-(user, workspace) coding-agent defaults.
--
-- Distinct from auth.user_preferences (user-GLOBAL, un-scoped): a default
-- repository and default environment are inherently workspace-scoped, since the
-- same user has a different repo/environment in each workspace they belong to.
-- This table is org/workspace-scoped (RLS-governed) and 1:1 per (user, workspace).
--
-- Backs user.workspace-preferences.read / user.workspace-preferences.write.
-- It also records whether the one-time "set a default repo?" prompt has been
-- shown (repo_default_prompted_at) so the app only asks once, the first time the
-- user opens the repo selector with no default set. Additive: absent rows ⇒
-- no defaults + never-prompted.

-- ── Create "workspace_user_preferences" table ────────────────────────────────
CREATE TABLE "auth"."workspace_user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"public_id" citext NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"default_repo_connection_id" text,
	"default_repo_slug" text,
	"default_environment_id" text,
	"repo_default_prompted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "workspace_user_preferences_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "workspace_user_preferences_user_id_users_id_fk"
	  FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX "workspace_user_preferences_user_workspace_idx"
  ON "auth"."workspace_user_preferences" USING btree ("user_id","workspace_id");
CREATE INDEX "workspace_user_preferences_org_workspace_idx"
  ON "auth"."workspace_user_preferences" USING btree ("org_id","workspace_id");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — standard tenant_isolation (org_id + workspace_id both NOT NULL).
-- Mirrors workspace.workspace_budget_policy (20260708120000).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE auth.workspace_user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.workspace_user_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth.workspace_user_preferences;
CREATE POLICY tenant_isolation ON auth.workspace_user_preferences
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants (guarded — fresh clusters may lack the role).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.workspace_user_preferences TO oxagen_app;
  END IF;
END
$$;
