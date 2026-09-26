-- Widen tacho.session_files line counts to bigint (#3944, audit finding S-02).
--
-- Git reconciliation assigns `lines_added` and `lines_removed` from the
-- envelope's u32, and an int4 column holds at most 2^31 - 1. A larger value
-- made Postgres refuse the upsert with 22003. Ingest answers that 400, so the
-- host quarantined the event and the session's dense-seq chain broke at it.
-- 20260925230200 widened every other counter the envelope feeds and missed
-- these two. `reads`, `writes`, `edits`, and `deletes` add one per event and
-- stay int4.
--
-- int4 to int8 rewrites the table under an ACCESS EXCLUSIVE lock. The table
-- holds one row per file a session touched, not one per event.

ALTER TABLE "tacho"."session_files"
  ALTER COLUMN "lines_added" TYPE bigint,
  ALTER COLUMN "lines_removed" TYPE bigint;
