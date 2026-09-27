-- The operator ranking's pseudonym setting (spend spec, Operator ranking; #2962).
--
-- One new table, workspace.operator_ranking_policy: one row per workspace.
-- With `pseudonyms` on, the ranking shows a stable pseudonym in place of each
-- operator's name. No row means off. `pseudonym_salt` is written once with
-- the row and keyed into each pseudonym's HMAC, so a pseudonym stays the same
-- across changes.
--
-- Shape mirrors the drizzle schema (packages/database/src/schema/workspace.ts
-- `operatorRankingPolicy`). RLS and grants are copied from
-- 20260927011500_no_progress_limit.sql.

-- ── Create "operator_ranking_policy" table ──────────────────────────────────
CREATE TABLE "workspace"."operator_ranking_policy" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pseudonyms" boolean DEFAULT false NOT NULL,
	-- The HMAC key for this workspace's pseudonyms. Never returned.
	"pseudonym_salt" uuid DEFAULT gen_random_uuid() NOT NULL,
	-- The user who last changed the setting.
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_ranking_policy_workspace_id_unique" UNIQUE("workspace_id")
);
CREATE INDEX "operator_ranking_policy_org_workspace_idx" ON "workspace"."operator_ranking_policy" USING btree ("org_id","workspace_id");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS for the `standard` class: org_id and workspace_id both NOT NULL.
--
-- `tenant_isolation` scopes every statement to the caller's workspace.
-- `tenant_org_wide_read` is the read widening every `standard` table in
-- POLICY_MANIFEST carries (20260917120000_org_wide_read_mode).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE workspace.operator_ranking_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.operator_ranking_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.operator_ranking_policy;
DROP POLICY IF EXISTS tenant_org_wide_read ON workspace.operator_ranking_policy;
CREATE POLICY tenant_isolation ON workspace.operator_ranking_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON workspace.operator_ranking_policy
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants, guarded because a fresh cluster may lack
-- the role.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.operator_ranking_policy TO oxagen_app;
  END IF;
END
$$;
