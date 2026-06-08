-- Drop orphaned schema tables: agent.agents, agent.agent_versions, workspace.folders, org.iam_sessions
-- These tables have schema definitions but zero CRUD references in the codebase.
-- Per oxagen-engineering-policy §3: "dead code and dead schema are FAIL."
-- All RLS policies are removed alongside table drops.

DROP TABLE IF EXISTS agent.agent_versions CASCADE;
DROP TABLE IF EXISTS agent.agents CASCADE;
DROP TABLE IF EXISTS workspace.folders CASCADE;
DROP TABLE IF EXISTS org.iam_sessions CASCADE;
