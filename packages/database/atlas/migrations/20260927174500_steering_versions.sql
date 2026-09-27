-- Published steering versions and the merge claim (S3, #4449).
--
-- 1. agent.steering_versions: each version publish() built from a steering
--    repository, with its bundle/v1. A number is never reused, even for a
--    version that was stored and never published. `published_at` is set the
--    first time the version is made the published one.
-- 2. agent.steering_publications: one row per steering repository. It names
--    the published version, and it holds the publish lease: while
--    `lease_until` is in the future, no other publish of the repository runs.
-- 3. agent.context_proposals.merge_claimed_at: set while merge_context_pr is
--    landing the proposal, so running the checks again does not move the row
--    under a merge the host is about to make.
--
-- Both new tables are tenant-isolated like every org-scoped table.

CREATE TABLE IF NOT EXISTS agent.steering_versions (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  repository text NOT NULL,
  version integer NOT NULL,
  commit_sha text NOT NULL,
  bundle jsonb NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "steering_versions_version_check" CHECK (version >= 1),
  CONSTRAINT "steering_versions_commit_check" CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);
CREATE UNIQUE INDEX IF NOT EXISTS steering_versions_version_uq ON agent.steering_versions (workspace_id, repository, version);
CREATE INDEX IF NOT EXISTS steering_versions_commit_idx ON agent.steering_versions (workspace_id, repository, commit_sha);

CREATE TABLE IF NOT EXISTS agent.steering_publications (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  repository text NOT NULL,
  published_version integer,
  published_commit text,
  ledger jsonb,
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "steering_publications_pointer_check" CHECK ((published_version IS NULL) = (published_commit IS NULL)),
  CONSTRAINT "steering_publications_lease_check" CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS steering_publications_repository_uq ON agent.steering_publications (workspace_id, repository);

ALTER TABLE agent.context_proposals ADD COLUMN IF NOT EXISTS merge_claimed_at timestamptz;

ALTER TABLE agent.steering_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.steering_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.steering_versions;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.steering_versions;
CREATE POLICY tenant_isolation ON agent.steering_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.steering_versions
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE agent.steering_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.steering_publications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.steering_publications;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.steering_publications;
CREATE POLICY tenant_isolation ON agent.steering_publications
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.steering_publications
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON agent.steering_versions TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE ON agent.steering_publications TO oxagen_app;
  END IF;
END $$;
