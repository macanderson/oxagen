-- Phase 2 fleet coordination (docs/specs/graph-mediated-fanout-phase2 §1, §2).
--
-- 1. Durable claim/lease on work rows: claimed_by (worker identity = Inngest
--    run id), lease_expires_at (null = unclaimed or terminal), attempts.
--    Claiming is a single atomic UPDATE … FOR UPDATE SKIP LOCKED; the
--    agent.lease-sweep cron requeues expired-lease rows until MAX_ATTEMPTS,
--    so a dead worker's task is reclaimed without a coordinator.
-- 2. Partial claim indexes: the claim UPDATE and the sweeper only ever scan
--    non-terminal rows.
-- 3. Widen agent_executions.origin_type CHECK with 'fanout' so terminal
--    fanout children can be projected as :Execution graph nodes (the CHECK
--    has rejected an unmigrated originType in prod before — schema edit and
--    migration must land together).
--
-- Hand-written + `atlas migrate hash` because `atlas migrate diff` is broken
-- by the pg_trgm fresh-replay defect
-- (docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md).

ALTER TABLE agent.subagent_runs
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

ALTER TABLE agent.agent_execution_steps
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS subagent_runs_claim_idx
  ON agent.subagent_runs (org_id, status)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS agent_execution_steps_claim_idx
  ON agent.agent_execution_steps (org_id, status)
  WHERE status IN ('pending', 'running');

ALTER TABLE agent.agent_executions
  DROP CONSTRAINT IF EXISTS agent_executions_origin_type_check;

ALTER TABLE agent.agent_executions
  ADD CONSTRAINT agent_executions_origin_type_check
  CHECK (origin_type IN ('chat', 'event_trigger', 'scheduled_job', 'mcp_request', 'workflow_run', 'fanout'));
