-- The instruction-file statements the Oxagen check flags in linked code
-- repositories (S7, #4518, ADR-263).
--
-- One row per statement the check on a pull request flagged: the repository,
-- the pull request, the commit the check read, the file, the line, and the
-- text. `list_code_repository_findings` compares each stored statement with
-- the workspace's active steering records on every read, so the row does not
-- keep which record it matched.
--
-- A check of an open pull request replaces that pull request's rows. A pull
-- request closed without merging deletes them. A merged one keeps them as
-- `merged` until a later merge changes the file and the statement is gone.

CREATE TABLE IF NOT EXISTS agent.code_repository_findings (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  provider_repository_id text NOT NULL,
  repository text NOT NULL,
  pull_request_number integer NOT NULL,
  pull_request_url text NOT NULL,
  pull_request_state text NOT NULL DEFAULT 'open',
  head_sha text NOT NULL,
  path text NOT NULL,
  line integer NOT NULL,
  statement text NOT NULL,
  proposal_public_id text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "code_repository_findings_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "code_repository_findings_provider_check" CHECK (provider IN ('github','gitlab')),
  CONSTRAINT "code_repository_findings_state_check" CHECK (pull_request_state IN ('open','merged')),
  CONSTRAINT "code_repository_findings_number_check" CHECK (pull_request_number > 0 AND line >= 1),
  CONSTRAINT "code_repository_findings_statement_check" CHECK (char_length(statement) BETWEEN 1 AND 4000),
  CONSTRAINT "code_repository_findings_proposal_check" CHECK (proposal_public_id IS NULL OR proposal_public_id ~ '^prp_[0-9A-Za-z]+$')
);
-- A statement starts on one line of one file, so a check writes one row for it.
CREATE UNIQUE INDEX IF NOT EXISTS code_repository_findings_statement_uq ON agent.code_repository_findings (workspace_id, provider, provider_repository_id, pull_request_number, path, line);
-- The read lists a workspace's rows, and a merge finds the rows on the files it changed.
CREATE INDEX IF NOT EXISTS code_repository_findings_repository_idx ON agent.code_repository_findings (org_id, workspace_id, provider, provider_repository_id, path);

COMMENT ON TABLE agent.code_repository_findings IS
  'Instruction-file statements the Oxagen check flagged on pull requests in linked code repositories (ADR-263).';
COMMENT ON COLUMN agent.code_repository_findings.pull_request_state IS
  'open while the pull request is open, merged once its lines reached the default branch.';
COMMENT ON COLUMN agent.code_repository_findings.proposal_public_id IS
  'The proposal promote_instruction_to_steering opened from the statement.';

ALTER TABLE agent.code_repository_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.code_repository_findings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.code_repository_findings;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.code_repository_findings;
CREATE POLICY tenant_isolation ON agent.code_repository_findings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.code_repository_findings
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.code_repository_findings TO oxagen_app;
  END IF;
END $$;
