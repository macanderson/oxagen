-- tacho.sessions.record_basis and tacho.sessions.backfill_normalizer
-- (#4028, ADR-161).
--
-- `record_basis` says how a session's frames reached the record:
--   live      the recorder sealed them while the session ran
--   backfill  `oxagen agent backfill` rebuilt them afterwards from the
--             transcript Claude Code kept; nothing was enforced during the run
--   mixed     a live resume continued a backfilled chain
-- Ingest sets it from the `oxagen.record_basis` attr every backfilled frame
-- carries. The Run page reads it for the "Backfilled" badge, the rollup
-- reads it to price the session as estimated, and ingest reads it to keep
-- backfilled cost out of the spend-budget counter.
--
-- `backfill_normalizer` is the normalizer version a backfill sealed the
-- session under, from its `agent_start`. `list_tacho_session_heads` answers
-- it, so a later pass on a host that lost its cursor file skips a session
-- already sealed under its own version.
--
-- NOT NULL with a constant default: Postgres 11 and later store the default
-- in the catalog, so no row is rewritten. Every row this finds reads `live`,
-- which is true of every session recorded before the backfill existed. The
-- check is added NOT VALID, so it takes no full-table scan under the ALTER's
-- lock; it holds for every row written from here on.
--
-- Hand-written, then `atlas migrate hash`.
--
-- Rollback:
--   ALTER TABLE tacho.sessions DROP CONSTRAINT tacho_sessions_record_basis_check;
--   ALTER TABLE tacho.sessions DROP COLUMN backfill_normalizer;
--   ALTER TABLE tacho.sessions DROP COLUMN record_basis;
--   Only ingest, list_tacho_session_heads, the rollup and the Run page read
--   the columns, and the previous code reads none of them.

ALTER TABLE "tacho"."sessions"
  ADD COLUMN IF NOT EXISTS "record_basis" text NOT NULL DEFAULT 'live';

ALTER TABLE "tacho"."sessions"
  ADD COLUMN IF NOT EXISTS "backfill_normalizer" text NULL;

ALTER TABLE "tacho"."sessions"
  ADD CONSTRAINT "tacho_sessions_record_basis_check"
  CHECK ("record_basis" IN ('live', 'backfill', 'mixed'))
  NOT VALID;

COMMENT ON COLUMN "tacho"."sessions"."record_basis" IS
  'How the frames reached the record: live, backfill (rebuilt from a transcript, nothing enforced), or mixed (a live resume continued a backfill). ADR-161.';

COMMENT ON COLUMN "tacho"."sessions"."backfill_normalizer" IS
  'The normalizer version a backfill sealed the session under. Null on a live session.';
