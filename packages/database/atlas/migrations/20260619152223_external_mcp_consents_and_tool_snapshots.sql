-- Modify "mcp_servers" table
ALTER TABLE "mcp"."mcp_servers" ADD COLUMN "deleted_at" timestamptz NULL, ADD COLUMN "deleted_by_user_id" uuid NULL;
-- Create "consents" table
CREATE TABLE "mcp"."consents" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "mcp_server_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "status" text NOT NULL,
  "granted_at" timestamptz NULL,
  "denied_at" timestamptz NULL,
  "expires_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "consents_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "consents_status_check" CHECK (status = ANY (ARRAY['granted'::text, 'denied'::text]))
);
-- Create index "consents_lookup_idx" to table: "consents"
CREATE INDEX "consents_lookup_idx" ON "mcp"."consents" ("workspace_id", "user_id", "mcp_server_id");
-- Create index "consents_ws_user_server_tool_uniq" to table: "consents"
CREATE UNIQUE INDEX "consents_ws_user_server_tool_uniq" ON "mcp"."consents" ("workspace_id", "user_id", "mcp_server_id", "tool_name");
-- Create "tool_snapshots" table
CREATE TABLE "mcp"."tool_snapshots" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "mcp_server_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "schema_json" jsonb NOT NULL,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "tool_snapshots_public_id_unique" UNIQUE ("public_id")
);
-- Create index "tool_snapshots_replay_idx" to table: "tool_snapshots"
CREATE INDEX "tool_snapshots_replay_idx" ON "mcp"."tool_snapshots" ("mcp_server_id", "tool_name", "captured_at");
-- Create "mcp_server_changes" table
CREATE TABLE "security"."mcp_server_changes" (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "server_id" uuid NOT NULL,
  "change_type" text NOT NULL,
  "actor_user_id" uuid NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "mcp_server_changes_change_type_check" CHECK (change_type = ANY (ARRAY['enable'::text, 'disable'::text, 'delete'::text]))
);
-- Create index "mcp_server_changes_org_occurred_idx" to table: "mcp_server_changes"
CREATE INDEX "mcp_server_changes_org_occurred_idx" ON "security"."mcp_server_changes" ("org_id", "occurred_at");
-- Create index "mcp_server_changes_server_idx" to table: "mcp_server_changes"
CREATE INDEX "mcp_server_changes_server_idx" ON "security"."mcp_server_changes" ("server_id", "change_type", "occurred_at");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS policies for the new tenant-owned tables (OXA-816 / OXA-820).
-- `drizzle-kit export` (the Atlas desired-state source) emits ONLY the Drizzle
-- schema, so tenant_isolation policies must be appended here by hand — exactly
-- like 20260612140000_restore_rls_policies.sql. All three tables carry
-- org_id + workspace_id NOT NULL → policyClass 'standard'
-- (USING = WITH CHECK = bypass OR matching org+workspace). The manifest entries
-- live in packages/database/src/tenant-policy.manifest.ts; the count assertion
-- in tenant-policy.manifest.test.ts is bumped 62 → 65.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE mcp.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.consents;
CREATE POLICY tenant_isolation ON mcp.consents
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE mcp.tool_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.tool_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.tool_snapshots;
CREATE POLICY tenant_isolation ON mcp.tool_snapshots
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE security.mcp_server_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.mcp_server_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security.mcp_server_changes;
CREATE POLICY tenant_isolation ON security.mcp_server_changes
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants for the new tables. The Atlas baseline
-- regrant (20260612052000_regrant_oxagen_app.sql) installs ALTER DEFAULT
-- PRIVILEGES per schema, so a fresh-environment replay already covers objects
-- created later. These explicit GRANTs are belt-and-suspenders for existing
-- environments where the new tables are created after the default-privilege
-- ALTER ran. Role guard mirrors the regrant migration — fresh CI/preview
-- clusters may not have provisioned oxagen_app yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.consents TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.tool_snapshots TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON security.mcp_server_changes TO oxagen_app;
  END IF;
END
$$;
