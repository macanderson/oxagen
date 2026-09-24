-- What sealed a wrapped session (#3980).
--
-- A session sealed only when its host sent an `agent_stop`: the harness's
-- SessionEnd hook, or the daemon's sweep when the harness process was gone.
-- A Claude Code terminal left open keeps its process alive, and a host whose
-- daemon stopped sends nothing, so those sessions read as running for days
-- and nothing was ever going to seal them.
--
-- The control plane now closes a session that has sent no event for twelve
-- hours (`tacho.session-idle-close`). That close is an inference, not the
-- host's word, so it stays open to correction: a later event reopens the
-- session and a later `agent_stop` replaces the close with the host's own
-- seal. This column is how ingest tells the two apart. `agent_stop` is a seal
-- the host sent and is final. `idle_timeout` is the control plane's close.
-- A row sealed before this column existed holds null and reads as
-- `agent_stop`, which is what every earlier seal was.
ALTER TABLE "tacho"."sessions"
  ADD COLUMN "seal_source" text;

-- NOT VALID: every row that exists when this runs holds NULL in a column this
-- statement's own migration just added, so the check holds for all of them,
-- and validating would scan the whole table under the ACCESS EXCLUSIVE lock
-- ingest waits on. New and updated rows are checked either way.
ALTER TABLE "tacho"."sessions"
  ADD CONSTRAINT "tacho_sessions_seal_source_check"
  CHECK ("seal_source" IS NULL OR "seal_source" IN ('agent_stop', 'idle_timeout'))
  NOT VALID;

-- The close job's scan: open sessions by last event. Partial, so it holds only
-- the sessions still open, a small share of the table. Not CONCURRENTLY:
-- atlas runs a migration in a transaction, and `tacho.sessions` is one row per
-- session rather than per event.
CREATE INDEX IF NOT EXISTS "tacho_sessions_open_last_event_idx"
  ON "tacho"."sessions" ("last_event_at")
  WHERE "sealed_at" IS NULL;
