-- The repository sync (ADR-184): one row per workspace saying which commit of
-- the main repository's production branch the context registry last matched,
-- and what was wrong with the record files at that commit. Tenant-isolated like
-- every org-scoped table.
CREATE TABLE IF NOT EXISTS agent.context_sync_state (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text,
  repository text,
  branch text,
  head_sha text,
  rules_sha text,
  status text NOT NULL DEFAULT 'pending',
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  requested_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "context_sync_state_status_check" CHECK (status IN ('pending', 'synced', 'problems', 'failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS context_sync_state_workspace_uq ON agent.context_sync_state (org_id, workspace_id);
ALTER TABLE agent.context_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.context_sync_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.context_sync_state;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.context_sync_state;
CREATE POLICY tenant_isolation ON agent.context_sync_state
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.context_sync_state
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON agent.context_sync_state TO oxagen_app;
  END IF;
END $$;
