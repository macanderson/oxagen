-- 0039_tacho_events_session_commits.sql
--
-- The commits a session made, as the oxagen:worktree_reconciled frame lists
-- them (ADR-297). session_commits is the list as JSON text: each commit's
-- name, parents, kind, patch id, dates, subject, line counts, files, the
-- test that counted it, and the tool call that made it.
-- session_commits_total is how many commits the session had before the list
-- was cut, and session_commits_truncated says whether it was cut.
--
-- Why this file exists beside 0027. 0027 is GENERATED from the @oxagen/tacho
-- envelope, so adding a body member rewrites it, and a cluster that already
-- applied 0027 skips the rewritten file and never gets the columns. This one
-- carries the three columns forward to every cluster bootstrapped before
-- them. Idempotent, so the order of the two on a fresh cluster does not
-- matter.
--
-- Backfill: none. A frame recorded before the collector sealed the list says
-- nothing about commits, and an empty list would claim the session made none.
ALTER TABLE tacho_events
  ADD COLUMN IF NOT EXISTS session_commits String AFTER observed_changes_truncated,
  ADD COLUMN IF NOT EXISTS session_commits_total Nullable(UInt32) AFTER session_commits,
  ADD COLUMN IF NOT EXISTS session_commits_truncated Nullable(Bool) AFTER session_commits_total;
