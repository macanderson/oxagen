-- 0007: Upgrade agent execution table RLS from org-only to standard (org+workspace).
--
-- agent.agent_executions, agent.agent_execution_steps, agent.agent_tool_calls were
-- added in the baseline with an org-only RLS predicate. All three tables have
-- workspace_id NOT NULL and carry orgScopeMixin — they get the standard policy.
-- Reference: migration_archive/0032_agent_execution_rls_standard.sql
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY.

BEGIN;

-- ── agent.agent_executions ───────────────────────────────────────────────────

DROP POLICY IF EXISTS agent_executions_tenant_isolation ON agent.agent_executions;

CREATE POLICY agent_executions_tenant_isolation ON agent.agent_executions
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

-- ── agent.agent_execution_steps ──────────────────────────────────────────────

DROP POLICY IF EXISTS agent_execution_steps_tenant_isolation ON agent.agent_execution_steps;

CREATE POLICY agent_execution_steps_tenant_isolation ON agent.agent_execution_steps
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

-- ── agent.agent_tool_calls ───────────────────────────────────────────────────

DROP POLICY IF EXISTS agent_tool_calls_tenant_isolation ON agent.agent_tool_calls;

CREATE POLICY agent_tool_calls_tenant_isolation ON agent.agent_tool_calls
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

COMMIT;
