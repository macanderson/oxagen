-- A steering repo's health (S2, #4560; steering-repo-spec, Settings drift).
--
-- agent.steering_repo_health holds one row per steering repo: its health
-- (healthy, drifted, disconnected, or diverged), the prescribed settings that
-- differ, and what Oxagen last posted and announced about it. While the
-- health is not healthy, Oxagen merges nothing and publishes nothing.
--
-- The organization repo <org>/oxagen belongs to no workspace, so its row has
-- a null workspace_id and the table uses the workspace_nullable policies.

CREATE TABLE IF NOT EXISTS agent.steering_repo_health (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid,
  provider text NOT NULL,
  repository_id bigint NOT NULL,
  repository text NOT NULL,
  health text NOT NULL,
  differences jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text,
  published_sha text,
  published_version integer,
  revert_pr_number integer,
  notified_health text NOT NULL DEFAULT 'healthy',
  posted_digest text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "steering_repo_health_provider_check" CHECK (provider IN ('github','gitlab')),
  CONSTRAINT "steering_repo_health_health_check" CHECK (health IN ('healthy','drifted','disconnected','diverged')),
  CONSTRAINT "steering_repo_health_notified_check" CHECK (notified_health IN ('healthy','drifted','disconnected','diverged'))
);
CREATE UNIQUE INDEX IF NOT EXISTS steering_repo_health_org_uq ON agent.steering_repo_health (org_id) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS steering_repo_health_workspace_uq ON agent.steering_repo_health (org_id, workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS steering_repo_health_repository_idx ON agent.steering_repo_health (provider, repository_id);

ALTER TABLE agent.steering_repo_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.steering_repo_health FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.steering_repo_health;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.steering_repo_health;
DROP POLICY IF EXISTS tenant_org_shared_read ON agent.steering_repo_health;
CREATE POLICY tenant_isolation ON agent.steering_repo_health
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON agent.steering_repo_health
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON agent.steering_repo_health
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);
