-- mcp.server_discoveries (M10, #4682): the last tool discovery of each
-- steering server.
--
-- One row per workspace and server folder. A discovery asks the server's
-- source which tools it offers, writes them to mcp.tool_snapshots, and opens
-- one sync steering PR when an imported tool's upstream differs from the
-- served lock. `withheld` names the tools whose input schema changed. The
-- gateway withholds them until that steering PR merges. `withheld_upstream`
-- names the same tools by their upstream names, and `offered` lists the
-- upstream names the source offered on the last read. The source columns
-- let the push webhook find the servers a push to a definition repository
-- touches. The table is tenant-isolated like every org-scoped table.

CREATE TABLE IF NOT EXISTS mcp.server_discoveries (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  server text NOT NULL,
  mcp_server_id uuid,
  status text NOT NULL DEFAULT 'queued',
  trigger text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  outcome text,
  tool_count integer,
  machine text,
  source_kind text,
  source_repo text,
  source_path text,
  source_ref text,
  schedule text,
  upstream_digest text,
  latest_version text,
  pr_number integer,
  pr_url text,
  pr_branch text,
  withheld text[] NOT NULL DEFAULT '{}',
  withheld_upstream text[] NOT NULL DEFAULT '{}',
  offered text[] NOT NULL DEFAULT '{}',
  CONSTRAINT "server_discoveries_status_check" CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT "server_discoveries_trigger_check" CHECK (trigger IN ('schedule', 'list_changed', 'push', 'registry_version', 'manual', 'lock_merged')),
  CONSTRAINT "server_discoveries_outcome_check" CHECK (outcome IS NULL OR outcome IN ('unchanged', 'pr_opened', 'pr_updated', 'needs_digest', 'skipped')),
  CONSTRAINT "server_discoveries_schedule_check" CHECK (schedule IS NULL OR schedule IN ('on-change', 'daily', 'manual')),
  CONSTRAINT "server_discoveries_pr_check" CHECK (pr_number IS NULL OR pr_number > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS server_discoveries_server_uniq ON mcp.server_discoveries (org_id, workspace_id, server);
CREATE INDEX IF NOT EXISTS server_discoveries_source_repo_idx ON mcp.server_discoveries (source_repo) WHERE schedule = 'on-change';
ALTER TABLE mcp.server_discoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.server_discoveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.server_discoveries;
DROP POLICY IF EXISTS tenant_org_wide_read ON mcp.server_discoveries;
CREATE POLICY tenant_isolation ON mcp.server_discoveries
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON mcp.server_discoveries
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.server_discoveries TO oxagen_app;
  END IF;
END $$;
