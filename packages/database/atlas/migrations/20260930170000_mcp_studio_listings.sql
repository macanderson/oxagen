-- An MCP Studio draft's tool listing (ADR-233, #4756).
--
-- A new server that runs on machines has no tools until a machine starts it.
-- start_studio_listing pins the draft's server and asks for one listing: a
-- machine in one of machine_groups starts the pinned package or command and
-- answers tools/list, and the MCP process that holds the machine's poll
-- writes the answer into the draft as its MCP source.
--
-- One row per draft. Asking again replaces the row. lock_source is the pin
-- the machine checks before it starts anything, in tools.lock.json's shape.
-- draft_revision is the revision the listing was asked on, so a listing never
-- writes into a draft saved after it was asked.
--
-- Every listing belongs to one workspace, so the table uses the standard
-- tenant policies.

CREATE TABLE IF NOT EXISTS mcp.studio_listings (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  draft_id uuid NOT NULL REFERENCES mcp.studio_drafts (id) ON DELETE CASCADE,
  server_name text NOT NULL,
  status text NOT NULL DEFAULT 'waiting_for_machine',
  machine_groups text[] NOT NULL DEFAULT '{}',
  lock_source jsonb NOT NULL,
  draft_revision integer NOT NULL,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  machine text,
  tool_count integer,
  error text,
  CONSTRAINT "studio_listings_status_check" CHECK (status IN ('waiting_for_machine', 'running', 'succeeded', 'failed')),
  CONSTRAINT "studio_listings_draft_revision_check" CHECK (draft_revision >= 1),
  CONSTRAINT "studio_listings_tool_count_check" CHECK (tool_count IS NULL OR tool_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_listings_draft_uniq ON mcp.studio_listings (draft_id);
CREATE INDEX IF NOT EXISTS studio_listings_open_idx ON mcp.studio_listings (org_id, workspace_id, requested_at) WHERE status IN ('waiting_for_machine', 'running');

ALTER TABLE mcp.studio_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.studio_listings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.studio_listings;
DROP POLICY IF EXISTS tenant_org_wide_read ON mcp.studio_listings;
CREATE POLICY tenant_isolation ON mcp.studio_listings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON mcp.studio_listings
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- The mcp schema's default privileges grant a new table on a fresh replay.
-- The explicit grant covers an environment where that default did not reach
-- it, as for mcp.studio_drafts. The role guard skips a cluster with no
-- oxagen_app.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.studio_listings TO oxagen_app;
  END IF;
END $$;
