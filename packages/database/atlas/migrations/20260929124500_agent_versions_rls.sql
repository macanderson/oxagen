-- Row-level security for agent.agent_versions (#2972).
--
-- agent.agent_versions holds each agent's version rows: the config a version
-- carries (the per-agent budget the Tacho host bundle reads), the runtime and
-- toolbelt it was bound to, and the user who wrote it. The table has no org_id
-- and no workspace_id, and no migration ever ran ENABLE, FORCE, or CREATE
-- POLICY on it. Its parent agent.agents is policied, but Postgres RLS is not
-- transitive. A query that names agent.agent_versions alone evaluates only that
-- table's policies, and there were none. A tenant-scoped session could read
-- every org's version rows and write a version row against another org's agent.
--
-- The policies scope each row through its agent and mirror the two policies
-- 20260917120000_org_wide_read_mode.sql puts on agent.agents:
--   tenant_isolation      Every command. Bypass is on, or the agent is in the
--                         current org and the current workspace.
--   tenant_org_wide_read  FOR SELECT. app.org_wide is on and the agent is in
--                         the current org.
--
-- The EXISTS reads the tenant GUCs itself instead of trusting the parent's
-- visibility. A policy subquery reads agent.agents under that table's own
-- policies, and under withOrgDb its tenant_org_wide_read admits every agent in
-- the org. A bare "the agent is visible" test would let an org-wide session
-- insert or update version rows for any workspace's agent. The org-wide
-- widening must stay read-only (packages/database/src/tenant.ts, withOrgDb).
--
-- A bypass-only policy would fail wrong here. These paths read or write the
-- table inside withTenantDb, where app.rls_bypass is off:
--   packages/handlers/src/lib/runtimes.ts           writeAgentVersion: SELECT, INSERT
--   packages/handlers/src/workspace-agents.ts       bootstrapWorkspaceAgents: SELECT, INSERT, UPDATE
--   packages/agent/src/handlers/agent.get.ts        SELECT
--   packages/agent/src/runtime/assistant-run.ts     SELECT
--   packages/handlers/src/lib/tacho-host.ts         SELECT
--   packages/handlers/src/lib/tacho-host-enroll.ts  SELECT
-- Each one reads or writes the agent row in the same transaction first, so the
-- agent is in scope and the policy admits its versions. The seed script, the
-- deprecated app's bootstrap, and the test cleanups run under withSystemDb.
--
-- No POLICY_MANIFEST entry: the manifest classes key on org_id and
-- workspace_id, and integration/manifest-coverage.test.ts only asks about
-- tables that carry them. integration/agent-versions-rls.test.ts holds this
-- migration in place instead.
--
-- agents.id is the primary key, so the EXISTS lookup is an index probe.

ALTER TABLE agent.agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_versions;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.agent_versions;
CREATE POLICY tenant_isolation ON agent.agent_versions
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM agent.agents a
      WHERE a.id = agent_versions.agent_id
        AND a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
        AND a.workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM agent.agents a
      WHERE a.id = agent_versions.agent_id
        AND a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
        AND a.workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );
CREATE POLICY tenant_org_wide_read ON agent.agent_versions
  FOR SELECT
  USING (
    current_setting('app.org_wide', true) = 'on'
    AND EXISTS (
      SELECT 1 FROM agent.agents a
      WHERE a.id = agent_versions.agent_id
        AND a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    )
  );

-- The policy subquery reads agent.agents as the invoking role, so oxagen_app
-- needs SELECT on the parent to satisfy a policy on the child.
-- 20260612052000_regrant_oxagen_app.sql already granted it schema-wide. This is
-- the guarded re-assertion the rest of the folder uses, and a no-op where the
-- grant already holds.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA agent TO oxagen_app;
    GRANT SELECT ON agent.agents TO oxagen_app;
  END IF;
END
$$;
