-- An operator's seal of a wrapped session (#4073, ADR-168).
--
-- A session seals when its host sends an `agent_stop`, or when the control
-- plane closes it after twelve silent hours (`idle_timeout`). A run whose
-- agent finished without either reads as live until then. An operator can
-- now seal it (`seal_run`): the control plane queues a kill for the agent on
-- its host and seals the session at once, recorded as `operator`. Like the
-- host's own seal, and unlike the idle close, it is final: a later frame or
-- `agent_stop` does not reopen or replace it.
ALTER TABLE "tacho"."sessions"
  DROP CONSTRAINT "tacho_sessions_seal_source_check";

-- NOT VALID, as the check it replaces was: every existing row already holds
-- one of the two earlier values or null, all of which the widened check
-- admits, and validating would scan the table under the lock ingest waits on.
-- New and updated rows are checked either way.
ALTER TABLE "tacho"."sessions"
  ADD CONSTRAINT "tacho_sessions_seal_source_check"
  CHECK ("seal_source" IS NULL OR "seal_source" IN ('agent_stop', 'idle_timeout', 'operator'))
  NOT VALID;
