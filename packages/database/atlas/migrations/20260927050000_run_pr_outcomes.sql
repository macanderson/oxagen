-- cost.run_pr_outcomes (#4491): what each sealed run's pull requests became.
--
-- One row per run and pull request, keyed by the run's public id and
-- `pr_key` (`github:owner/repo#N`, or `none` for a run that opened no pull
-- request). Each value carries the time Oxagen read it. The hourly refresh and
-- the GitHub pull request and push deliveries write it, and the findings job
-- reads it to price spend with no outcome. It is a derived index like
-- cost.run_totals, and it is tenant-isolated like every org-scoped table.

CREATE TABLE IF NOT EXISTS cost.run_pr_outcomes (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  run_id text NOT NULL,
  run_source text NOT NULL,
  pr_key text NOT NULL,
  provider text,
  repository text,
  number integer,
  url text,
  pr_state text,
  pr_state_read_at timestamptz,
  forge_read_attempted_at timestamptz,
  closed_at timestamptz,
  merged boolean NOT NULL DEFAULT false,
  merged_at timestamptz,
  merge_commit_sha text,
  base_ref text,
  head_ref text,
  head_sha text,
  head_branch_exists boolean,
  head_branch_read_at timestamptz,
  ci_state text,
  ci_read_at timestamptz,
  reverted boolean NOT NULL DEFAULT false,
  reverted_by text,
  reverted_at timestamptz,
  reverted_read_at timestamptz,
  terminal_reason text,
  terminal_reason_read_at timestamptz,
  source_updated_at timestamptz,
  CONSTRAINT "run_pr_outcomes_run_source_check" CHECK (run_source IN ('ledger', 'tacho')),
  CONSTRAINT "run_pr_outcomes_run_id_check" CHECK (run_id ~ '^(arun|tse)_[0-9a-z]+$'),
  CONSTRAINT "run_pr_outcomes_provider_check" CHECK (provider IS NULL OR provider IN ('github', 'gitlab')),
  CONSTRAINT "run_pr_outcomes_key_check" CHECK ((pr_key = 'none' AND provider IS NULL AND repository IS NULL AND number IS NULL) OR (pr_key <> 'none' AND provider IS NOT NULL AND repository IS NOT NULL AND number > 0)),
  CONSTRAINT "run_pr_outcomes_pr_state_check" CHECK (pr_state IS NULL OR pr_state IN ('open', 'closed', 'merged')),
  CONSTRAINT "run_pr_outcomes_merged_check" CHECK (pr_state IS NULL OR (pr_state = 'merged') = merged),
  CONSTRAINT "run_pr_outcomes_ci_state_check" CHECK (ci_state IS NULL OR ci_state IN ('passed', 'failed', 'pending', 'none')),
  CONSTRAINT "run_pr_outcomes_reverted_check" CHECK (NOT reverted OR reverted_by IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS run_pr_outcomes_run_pr_uniq ON cost.run_pr_outcomes (run_id, pr_key);
CREATE INDEX IF NOT EXISTS run_pr_outcomes_workspace_run_idx ON cost.run_pr_outcomes (org_id, workspace_id, run_id);
CREATE INDEX IF NOT EXISTS run_pr_outcomes_forge_idx ON cost.run_pr_outcomes (org_id, workspace_id, repository, number);
CREATE INDEX IF NOT EXISTS run_pr_outcomes_merge_commit_idx ON cost.run_pr_outcomes (org_id, workspace_id, merge_commit_sha) WHERE merge_commit_sha IS NOT NULL;
ALTER TABLE cost.run_pr_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost.run_pr_outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cost.run_pr_outcomes;
DROP POLICY IF EXISTS tenant_org_wide_read ON cost.run_pr_outcomes;
CREATE POLICY tenant_isolation ON cost.run_pr_outcomes
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON cost.run_pr_outcomes
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON cost.run_pr_outcomes TO oxagen_app;
  END IF;
END $$;
