-- 0032: Upgrade agent execution table RLS from org-only to standard (org+workspace).
--
-- Tables agent.agent_executions, agent.agent_execution_steps, and
-- agent.agent_tool_calls were added in migration 0030 with an org-only RLS
-- predicate (only checking org_id). All three tables have workspace_id NOT NULL
-- and carry orgScopeMixin — they should use the standard org+workspace isolation
-- policy consistent with every other orgScopeMixin table in the schema.
--
-- This migration drops the weaker org-only policies and replaces them with the
-- standard predicate. Because withTenantDb always sets both app.current_org_id
-- and app.current_workspace_id GUCs, and all handlers go through withTenantDb,
-- this change does not break any existing read or write paths.

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
