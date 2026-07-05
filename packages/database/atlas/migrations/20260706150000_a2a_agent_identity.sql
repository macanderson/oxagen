-- A2A agent identity, lineage & fan-out tie-in (docs/specs/a2a-agent-identity).
--
-- 1. agent.agent_executions.origin_type CHECK gains 'a2a' so bridge.ts can
--    record one execution row per A2A task (originId = agent.a2a_tasks.id).
-- 2. agent.a2a_tasks gains:
--      - agent_id     (app-enforced ref to agent.agents.id)      — which
--        agent this task is/was addressed to (skillId routing input).
--      - fanout_run_id (app-enforced ref to agent.subagent_runs.id) — set
--        only when the task was opened from inside a leased subagent run.
--    Both nullable; no cross-schema/table FK per CLAUDE.md storage rules
--    (same pattern as agent.agent_triggers.connection_id).
--
-- No Neo4j/ClickHouse changes — transactional lineage/routing state belongs
-- in Postgres per the infrastructure boundaries in CLAUDE.md.

ALTER TABLE agent.agent_executions
  DROP CONSTRAINT IF EXISTS agent_executions_origin_type_check;

ALTER TABLE agent.agent_executions
  ADD CONSTRAINT agent_executions_origin_type_check
  CHECK (origin_type IN ('chat', 'event_trigger', 'scheduled_job', 'mcp_request', 'workflow_run', 'fanout', 'a2a'));

ALTER TABLE agent.a2a_tasks
  ADD COLUMN IF NOT EXISTS "agent_id" uuid NULL,
  ADD COLUMN IF NOT EXISTS "fanout_run_id" uuid NULL;

CREATE INDEX IF NOT EXISTS "a2a_tasks_agent_idx"
  ON "agent"."a2a_tasks" ("org_id", "workspace_id", "agent_id");
