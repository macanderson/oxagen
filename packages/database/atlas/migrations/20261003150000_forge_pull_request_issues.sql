-- forge.pull_request_issues (ADR-292): the issues each pull request closes,
-- as the forge's closing references name them at the pull request's latest
-- head. An issue is keyed by the forge's node id, the id work.items.provider_id
-- carries as issue:node:<id>, so a work item and the pull requests that close
-- its issue meet on one value. Many to many: a pull request can close several
-- issues, and several pull requests can name one issue.

CREATE TABLE IF NOT EXISTS forge.pull_request_issues (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  pull_request_id uuid NOT NULL REFERENCES forge.pull_requests (id) ON DELETE CASCADE,
  issue_node_id text NOT NULL,
  repository text NOT NULL,
  number integer NOT NULL,
  url text NOT NULL,
  title text,
  state text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pull_request_issues_number_check" CHECK (number > 0),
  CONSTRAINT "pull_request_issues_state_check" CHECK (state IN ('open','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_request_issues_link_uq ON forge.pull_request_issues (pull_request_id, issue_node_id);
CREATE INDEX IF NOT EXISTS pull_request_issues_issue_idx ON forge.pull_request_issues (org_id, workspace_id, issue_node_id);
CREATE INDEX IF NOT EXISTS pull_request_issues_url_idx ON forge.pull_request_issues (org_id, workspace_id, url);

COMMENT ON TABLE forge.pull_request_issues IS
  'The issues each pull request closes, from the forge''s closing references at its latest head (ADR-292).';
COMMENT ON COLUMN forge.pull_request_issues.issue_node_id IS
  'The forge''s node id; work.items.provider_id names the same issue as issue:node:<id>.';

ALTER TABLE forge.pull_request_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge.pull_request_issues FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON forge.pull_request_issues;
DROP POLICY IF EXISTS tenant_org_wide_read ON forge.pull_request_issues;
CREATE POLICY tenant_isolation ON forge.pull_request_issues
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON forge.pull_request_issues
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON forge.pull_request_issues TO oxagen_app;
  END IF;
END $$;
