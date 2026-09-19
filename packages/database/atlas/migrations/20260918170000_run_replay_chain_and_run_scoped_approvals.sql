-- Run replay, part 2: what a recording was observed at, and which run a parked
-- call belongs to.
--
-- 1. agent.agent_run_attempt_seals.enforcement_tier
--
-- The replay ladder's `fork` rung is only reachable on a gateway-observed
-- recording (Mission Control spec §8.4), and until now the ledger's seal path
-- pinned every attempt to `harness`, so no ledger run could ever record
-- `fork` however complete its cassette was. The tier is a property of the
-- recording, derived once at seal from the rows (`ledgerEnforcementTier`)
-- exactly like the grade beside it, so it is written next to the grade rather
-- than recomputed by every reader.
--
-- Nullable, with no backfill: a seal written before this migration was graded
-- without a recorded tier, and writing one in now would assert something
-- nobody observed. A reader treats a null as `harness`, which is what the seal
-- was graded under.
--
-- 2. agent.approval_requests.run_public_id
--
-- An approval row named `message_id`, `execution_step_id` and `tool_call_id`
-- and none of them reached a run, so `list_approvals` answered every `runId`
-- filter with an empty page and the Run page's Policy tab could only ever say
-- "no parked calls" (#3286). The reference is a public id rather than a
-- foreign key because both kinds of run this product tracks have to be
-- representable — the ledger's `agent_runs` (`arun_…`) and the wrapped
-- `tacho.sessions` (`tse_…`) — and no one table holds both.
--
-- Nullable: a call parked outside any run (a mandate hop with no run in scope)
-- records none, and a null means "not recorded", never "some other run".

ALTER TABLE agent.agent_run_attempt_seals
  ADD COLUMN IF NOT EXISTS enforcement_tier text;

ALTER TABLE agent.agent_run_attempt_seals
  ADD CONSTRAINT agent_run_attempt_seals_enforcement_tier_check
  CHECK (
    enforcement_tier IS NULL
    OR enforcement_tier IN ('gateway', 'harness', 'observe')
  );

ALTER TABLE agent.approval_requests
  ADD COLUMN IF NOT EXISTS run_public_id text;

ALTER TABLE agent.approval_requests
  ADD CONSTRAINT approval_requests_run_public_id_check
  CHECK (
    run_public_id IS NULL
    OR run_public_id ~ '^(arun|tse)_[0-9a-z]+$'
  );

-- The Run page's Policy tab reads one run's parked calls inside one workspace.
CREATE INDEX IF NOT EXISTS approval_requests_run_idx
  ON agent.approval_requests (workspace_id, run_public_id)
  WHERE run_public_id IS NOT NULL;
