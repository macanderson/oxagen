-- cost.run_pr_receipt_walks (#4511): where the outcome refresh stands in each
-- ledger run's pull request receipts.
--
-- The hourly refresh (packages/handlers run-pr-outcomes-refresh.ts) names a
-- ledger run's pull requests from its `provider_publish.pull_request_opened`
-- events. One pass reads at most 20 pages of 500 events per run, so a run
-- with more events took the receipts before the bound and lost the rest, and
-- a run whose receipt named a repository the workspace no longer connects got
-- no row and was read again on every pass, newest first. A hundred such runs
-- held every slot and older runs never got an outcome.
--
-- One row per ledger run the refresh has walked. `after_seq` is the run_seq of
-- the last event read, and the next pass resumes after it. `receipts` holds
-- the receipts read so far, as [{repositoryId, number, headSha}]. The refresh
-- writes the run's outcome rows only once `complete` is true and every receipt
-- names a connected repository. A run it cannot resolve records why in
-- `unresolved` and waits until `retry_after`, so it holds no slot meanwhile.
-- The refresh deletes a workspace's rows created more than 31 days ago: their
-- runs started before the 30-day outcome window. Like cost.run_pr_outcomes, it
-- is a derived index.

CREATE TABLE IF NOT EXISTS cost.run_pr_receipt_walks (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  run_id text NOT NULL,
  after_seq text,
  complete boolean NOT NULL DEFAULT false,
  receipts jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempted_at timestamptz NOT NULL,
  unresolved text,
  retry_after timestamptz,
  CONSTRAINT "run_pr_receipt_walks_run_id_check" CHECK (run_id ~ '^arun_[0-9a-z]+$'),
  CONSTRAINT "run_pr_receipt_walks_receipts_check" CHECK (jsonb_typeof(receipts) = 'array'),
  CONSTRAINT "run_pr_receipt_walks_unresolved_check" CHECK (unresolved IS NULL OR unresolved IN ('run_not_found', 'repository_not_connected', 'read_failed')),
  CONSTRAINT "run_pr_receipt_walks_retry_check" CHECK ((unresolved IS NULL) = (retry_after IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS run_pr_receipt_walks_run_uniq ON cost.run_pr_receipt_walks (org_id, workspace_id, run_id);
CREATE INDEX IF NOT EXISTS run_pr_receipt_walks_created_idx ON cost.run_pr_receipt_walks (org_id, workspace_id, created_at);
ALTER TABLE cost.run_pr_receipt_walks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost.run_pr_receipt_walks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cost.run_pr_receipt_walks;
DROP POLICY IF EXISTS tenant_org_wide_read ON cost.run_pr_receipt_walks;
CREATE POLICY tenant_isolation ON cost.run_pr_receipt_walks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON cost.run_pr_receipt_walks
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON cost.run_pr_receipt_walks TO oxagen_app;
  END IF;
END $$;
