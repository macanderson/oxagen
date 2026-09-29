-- An MCP Studio draft (M11, #4686; mcp-studio-spec, Steering PR).
--
-- mcp.studio_drafts holds one live draft per workspace and server name. The
-- server name is the folder under tools/servers/ in the steering repo, so it
-- follows SERVER_NAME_PATTERN in packages/oxagen/src/steering-repo/names.ts.
-- Built-in tools own the name `builtin`, so no draft may take it. `ops`
-- lists the edits the Studio has recorded, in order. `server_toml` is the
-- server.toml the draft would commit. `revision` is the draft's save counter
-- and starts at 1. The pr_* columns name the steering pull request the draft
-- opened. `mcp_server_id` points at the served server the draft edits and is
-- null for a new server.
--
-- The draft holds no credential value. `server_toml` names a credential only
-- by `oxagen:credential/<name>`.
--
-- Every draft belongs to one workspace, so the table uses the standard
-- tenant policies.

CREATE TABLE IF NOT EXISTS mcp.studio_drafts (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  updated_by_id uuid,
  deleted_at timestamptz,
  deleted_by_id uuid,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  server_name text NOT NULL,
  mcp_server_id uuid REFERENCES mcp.mcp_servers (id) ON DELETE SET NULL,
  ops jsonb NOT NULL DEFAULT '[]'::jsonb,
  server_toml text,
  source jsonb,
  revision integer NOT NULL DEFAULT 1,
  pr_number integer,
  pr_url text,
  pr_branch text,
  CONSTRAINT "studio_drafts_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "studio_drafts_server_name_check" CHECK (server_name ~ '^[a-z][a-z0-9_]{0,23}$'),
  CONSTRAINT "studio_drafts_server_name_reserved_check" CHECK (server_name <> 'builtin'),
  CONSTRAINT "studio_drafts_ops_check" CHECK (jsonb_typeof(ops) = 'array'),
  CONSTRAINT "studio_drafts_server_toml_check" CHECK (octet_length(server_toml) <= 262144),
  CONSTRAINT "studio_drafts_revision_check" CHECK (revision >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_studio_drafts_server_uq ON mcp.studio_drafts (org_id, workspace_id, server_name) WHERE deleted_at IS NULL;

ALTER TABLE mcp.studio_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.studio_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.studio_drafts;
DROP POLICY IF EXISTS tenant_org_wide_read ON mcp.studio_drafts;
CREATE POLICY tenant_isolation ON mcp.studio_drafts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON mcp.studio_drafts
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- 20260612052000_regrant_oxagen_app.sql sets default privileges on the mcp
-- schema, so a fresh replay already grants this table. The explicit grant
-- matches mcp.consents and covers an environment where that default did not
-- reach the new table. The role guard skips a cluster with no oxagen_app.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.studio_drafts TO oxagen_app;
  END IF;
END $$;
