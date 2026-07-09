-- agent.sandbox_sessions — session lifecycle & work-recovery columns.
--
-- Spec: docs/specs/sandbox-session-lifecycle/spec.md §5.1.
--
-- Adds the state a session-scoped reaper needs to (a) drop a warm sandbox 2-3
-- minutes after it goes idle and (b) NEVER flush a sandbox with uncommitted work
-- before that work is captured to a recovery branch. All columns are additive
-- and nullable/defaulted, so the change is safe to apply ahead of the code that
-- reads them (existing rows default to recovery_status='none').
--
-- Notes:
--   - RLS/grants inherit from the base table (20260628120000); no policy change.
--   - The partial reap index stays tiny (only live-but-idle rows).

ALTER TABLE "agent"."sandbox_sessions"
  -- Reap-eligible instant = last_used_at + grace, written on release-to-idle.
  ADD COLUMN IF NOT EXISTS "grace_deadline_at" timestamptz NULL,
  -- Work-safety state, orthogonal to `status`: none|pending|recovering|recovered|failed.
  ADD COLUMN IF NOT EXISTS "recovery_status" text NOT NULL DEFAULT 'none',
  -- Branch/commit the reaper pushed uncommitted work to.
  ADD COLUMN IF NOT EXISTS "recovery_branch" text NULL,
  ADD COLUMN IF NOT EXISTS "recovery_commit" text NULL,
  -- Failure reason when recovery_status='failed' (sandbox retained, not flushed).
  ADD COLUMN IF NOT EXISTS "recovery_error" text NULL,
  ADD COLUMN IF NOT EXISTS "recovered_at" timestamptz NULL,
  -- When the reaper terminated the sandbox (distinct from an explicit stop).
  ADD COLUMN IF NOT EXISTS "flushed_at" timestamptz NULL,
  -- Last-observed uncommitted-changes state (NULL = never checked).
  ADD COLUMN IF NOT EXISTS "dirty" boolean NULL,
  ADD COLUMN IF NOT EXISTS "dirty_checked_at" timestamptz NULL;

-- Recovery-status domain guard (mirrors the Drizzle CHECK).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sandbox_sessions_recovery_status_check'
  ) THEN
    ALTER TABLE "agent"."sandbox_sessions"
      ADD CONSTRAINT "sandbox_sessions_recovery_status_check"
      CHECK (recovery_status IN ('none', 'pending', 'recovering', 'recovered', 'failed'));
  END IF;
END
$$;

-- Reaper candidate scan: idle sessions past their grace deadline not yet flushed.
CREATE INDEX IF NOT EXISTS "sandbox_sessions_reap_idx"
  ON "agent"."sandbox_sessions" ("grace_deadline_at")
  WHERE (flushed_at IS NULL AND grace_deadline_at IS NOT NULL);
