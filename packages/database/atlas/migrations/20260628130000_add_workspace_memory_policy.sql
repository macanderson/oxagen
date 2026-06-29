-- OXA-1374: workspace.workspace_memory_policy — per-workspace agent-memory decay
-- policy (half-lives + recall threshold).
--
-- The Drizzle table (packages/database/src/schema/workspace.ts) and the
-- agent.memory.policy.read / agent.memory.policy.write capability handlers
-- shipped, but no migration ever created the table — so every environment threw
-- `relation "workspace.workspace_memory_policy" does not exist` (42P01) the
-- moment the Memory settings page (or any policy read/write) ran. This creates
-- it with the standard tenant-owned-table shape + RLS, unblocking that surface.
--
-- The CREATE TABLE / index block is copied verbatim from `drizzle-kit export`
-- so a future `atlas migrate diff` sees zero drift. RLS + oxagen_app grants are
-- appended by hand (drizzle-kit export emits only the Drizzle schema), matching
-- 20260621180000_slug_history_tables.sql and 20260612140000_restore_rls_policies.sql.

-- ── Create "workspace_memory_policy" table ───────────────────────────────────
CREATE TABLE "workspace"."workspace_memory_policy" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"half_life_low_days" integer DEFAULT 30 NOT NULL,
	"half_life_high_days" integer DEFAULT 90 NOT NULL,
	"recall_threshold" real DEFAULT 0.1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memory_policy_workspace_id_unique" UNIQUE("workspace_id")
);
CREATE UNIQUE INDEX "workspace_memory_policy_workspace_idx" ON "workspace"."workspace_memory_policy" USING btree ("workspace_id");
CREATE INDEX "workspace_memory_policy_org_workspace_idx" ON "workspace"."workspace_memory_policy" USING btree ("org_id","workspace_id");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — standard tenant_isolation (org_id + workspace_id both NOT NULL).
-- Matches the workspace.workspace_slug_history block in 20260621180000.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE workspace.workspace_memory_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.workspace_memory_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.workspace_memory_policy;
CREATE POLICY tenant_isolation ON workspace.workspace_memory_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants. Belt-and-suspenders for existing
-- environments where this table is created after the per-schema ALTER DEFAULT
-- PRIVILEGES ran (20260612052000_regrant_oxagen_app.sql). Role guard mirrors the
-- regrant migration — fresh CI/preview clusters may not have provisioned the
-- oxagen_app role yet.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.workspace_memory_policy TO oxagen_app;
  END IF;
END
$$;
