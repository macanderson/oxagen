-- cost.run_pr_delivered_states (#4511): the newest state a GitHub delivery
-- carried for each pull request.
--
-- A pull request delivery folds its state into the cost.run_pr_outcomes rows
-- that name the pull request. A delivery that lands before the hourly refresh
-- (packages/handlers run-pr-outcomes-refresh.ts) writes a run's first row
-- found no row, wrote nothing, and was lost. The refresh then wrote the state
-- it had read from GitHub, which could be older: a pull request that reopened
-- after that read was stored closed until the next delivery.
--
-- Every pull request delivery now also keeps its state here, one row per pull
-- request, under the order cost.run_pr_outcomes keeps: a later
-- `source_updated_at` wins, and the later `read_at` wins between two equal
-- ones. Each refresh pass folds these states into the rows it writes. The
-- delivery deletes the workspace's rows read more than 31 days ago, since
-- every run in the 30-day outcome window started after them. Like
-- cost.run_pr_outcomes, it is a derived index.

CREATE TABLE IF NOT EXISTS cost.run_pr_delivered_states (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  pr_key text NOT NULL,
  pr_state text NOT NULL,
  read_at timestamptz NOT NULL,
  closed_at timestamptz,
  merged_at timestamptz,
  merge_commit_sha text,
  base_ref text,
  head_ref text,
  head_sha text,
  source_updated_at timestamptz,
  CONSTRAINT "run_pr_delivered_states_pr_key_check" CHECK (pr_key ~ '^github:[^#]+#[1-9][0-9]*$'),
  CONSTRAINT "run_pr_delivered_states_pr_state_check" CHECK (pr_state IN ('open', 'closed', 'merged'))
);
CREATE UNIQUE INDEX IF NOT EXISTS run_pr_delivered_states_pr_uniq ON cost.run_pr_delivered_states (org_id, workspace_id, pr_key);
CREATE INDEX IF NOT EXISTS run_pr_delivered_states_workspace_read_idx ON cost.run_pr_delivered_states (org_id, workspace_id, read_at);
ALTER TABLE cost.run_pr_delivered_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost.run_pr_delivered_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cost.run_pr_delivered_states;
DROP POLICY IF EXISTS tenant_org_wide_read ON cost.run_pr_delivered_states;
CREATE POLICY tenant_isolation ON cost.run_pr_delivered_states
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON cost.run_pr_delivered_states
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON cost.run_pr_delivered_states TO oxagen_app;
  END IF;
END $$;
