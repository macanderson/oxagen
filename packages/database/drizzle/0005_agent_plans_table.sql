-- 0005: agent.agent_plans table with RLS.
--
-- Adds agent.agent_plans for structured execution plans with approval gates.
-- Status flow: draft → awaiting_approval → approved | denied | amended → executing → completed
-- Reference: migration_archive/0031_agent_plans.sql
-- Idempotent: CREATE TABLE IF NOT EXISTS + DROP/CREATE policy.

BEGIN;

CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE IF NOT EXISTS agent.agent_plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id            citext      NOT NULL UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid,
  updated_by_user_id   uuid,
  org_id               uuid        NOT NULL,
  workspace_id         uuid        NOT NULL,
  status               citext      NOT NULL DEFAULT 'draft',
  goals                jsonb       NOT NULL DEFAULT '[]'::jsonb,
  constraints          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tasks                jsonb       NOT NULL DEFAULT '[]'::jsonb,
  approval_required    boolean     NOT NULL DEFAULT true,
  message_id           uuid,
  approved_at          timestamptz,
  approved_by_user_id  uuid,
  task_count           integer     NOT NULL DEFAULT 0,

  CONSTRAINT agent_plans_status_check
    CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'denied', 'amended', 'executing', 'completed')),
  CONSTRAINT agent_plans_task_count_check
    CHECK (task_count >= 0 AND task_count <= 100),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_plans_org_status_idx
  ON agent.agent_plans(org_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS agent_plans_org_idx
  ON agent.agent_plans(org_id, workspace_id);
CREATE INDEX IF NOT EXISTS agent_plans_message_idx
  ON agent.agent_plans(message_id);

ALTER TABLE agent.agent_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_plans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_plans_tenant_isolation ON agent.agent_plans;

-- Initial policy is org-only; 0009 upgrades to standard (org+workspace).
CREATE POLICY agent_plans_tenant_isolation ON agent.agent_plans
  USING (current_setting('app.rls_bypass', true) = 'on'
    OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on'
    OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON agent.agent_plans TO oxagen_app;

COMMIT;
