-- tacho.sessions.repository_unlinked: whether a wrapped session opened in a
-- repository its workspace has not linked (#4516, lane S8).
--
-- Ingest writes the flag once, on the session's genesis row. It is true when
-- the session reported a `git_remote_digest` and that digest matched no
-- repository binding head in the workspace the host's key names. A session
-- with no digest, a session in a linked repository, and a session whose
-- lookup failed all write false. Nothing refuses an unlinked session, and its
-- cost goes to the key's workspace either way. `get_run` and
-- `get_tacho_session` answer the flag.
--
-- NOT NULL with a constant default: Postgres 11 and later store the default
-- in the catalog, so no row is rewritten. The ALTER takes an ACCESS EXCLUSIVE
-- lock on tacho.sessions for the catalog change only.
--
-- No backfill. A session recorded before this reads false, which is what it
-- reads when its lookup fails: not known to be unlinked.
--
-- Hand-written, then `atlas migrate hash`.
--
-- Rollback:
--   ALTER TABLE tacho.sessions DROP COLUMN repository_unlinked;
--   Nothing but the two reads above uses the column, so the previous code
--   runs unchanged after a rollback.

ALTER TABLE "tacho"."sessions"
  ADD COLUMN IF NOT EXISTS "repository_unlinked" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "tacho"."sessions"."repository_unlinked" IS
  'True when the session''s git_remote_digest matched no repository linked to its workspace when it opened. Written once, at genesis.';
