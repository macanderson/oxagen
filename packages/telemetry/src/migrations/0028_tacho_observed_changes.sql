-- 0028_tacho_observed_changes.sql
--
-- The observed side of a run's file facts: what git says the worktree holds,
-- rather than what a tool announced. Three columns for the
-- oxagen:worktree_reconciled frame the collector seals at a turn boundary.
-- observed_changes is the per-path list as JSON text (path, repo-relative
-- path, status, and the two line counts); observed_changes_total is how many
-- paths were seen before the list was cut; observed_changes_truncated says
-- whether it was cut.
--
-- Why this file exists beside 0027. 0027 is GENERATED from the @oxagen/tacho
-- envelope, so adding a body member rewrites it, and a cluster that already
-- applied 0027 skips the rewritten file and never gets the columns. The
-- generated file keeps describing the whole table for a cluster bootstrapped
-- today; this one carries the same three columns forward to every cluster
-- that was bootstrapped before them. Idempotent, so the order of the two on a
-- fresh cluster does not matter.
--
-- Backfill: none. No historical row observed a worktree, and a zero would
-- read as "nothing changed" rather than "nobody looked", so the columns stay
-- empty for every frame recorded before the collector started sealing them.
ALTER TABLE tacho_events
  ADD COLUMN IF NOT EXISTS observed_changes String AFTER completeness_gaps,
  ADD COLUMN IF NOT EXISTS observed_changes_total Nullable(UInt32) AFTER observed_changes,
  ADD COLUMN IF NOT EXISTS observed_changes_truncated Nullable(Bool) AFTER observed_changes_total;
