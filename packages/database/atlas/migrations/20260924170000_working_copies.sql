-- Working copies: the directories `oxagen init` linked to a workspace, as the
-- CLI reports them (record_working_copy, list_working_copies). One row per
-- machine and directory. Tenant-isolated like every org-scoped table.
CREATE TABLE IF NOT EXISTS ingestion.working_copies (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  machine_id text NOT NULL,
  hostname text NOT NULL,
  directory text NOT NULL,
  repository_full_name text,
  branch text,
  head_commit text,
  oxagen_present boolean NOT NULL,
  symlinks text NOT NULL,
  pulled_commit text,
  last_event text NOT NULL,
  cli_version text,
  reported_by_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT working_copies_public_id_unique UNIQUE(public_id),
  CONSTRAINT "working_copies_symlinks_check" CHECK (symlinks IN ('linked', 'missing', 'none')),
  CONSTRAINT "working_copies_last_event_check" CHECK (last_event IN ('init', 'pull'))
);
CREATE UNIQUE INDEX IF NOT EXISTS working_copies_directory_uq ON ingestion.working_copies (org_id, workspace_id, machine_id, directory);
CREATE INDEX IF NOT EXISTS working_copies_seen_idx ON ingestion.working_copies (org_id, workspace_id, last_seen_at);
ALTER TABLE ingestion.working_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.working_copies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.working_copies;
DROP POLICY IF EXISTS tenant_org_wide_read ON ingestion.working_copies;
CREATE POLICY tenant_isolation ON ingestion.working_copies
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON ingestion.working_copies
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON ingestion.working_copies TO oxagen_app;
  END IF;
END $$;
