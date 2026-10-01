-- Memory uses and the memory lifecycle (MEM2, #4908, ADR-245).
--
-- 1. agent.memories keeps every row for life. `state` replaces the purge
--    that deleted a memory once its memory PR settled: waiting, in_pr,
--    promoted, dismissed, or retired. A retired memory carries `retired_at`
--    and `retired_reason` (`deleted` or `unused`). A promoted memory names
--    its record in `promoted_lineage`.
-- 2. agent.memories gains a Claude Code memory file's frontmatter: `label`
--    (name), `summary` (description), and `memory_type` (metadata.type).
-- 3. agent.memories gains `use_count` and `last_used_at`, which the store
--    computes from agent.memory_uses whenever it writes a use.
-- 4. agent.memories takes capture `import`, for Markdown imported as
--    memories (#4907).
-- 5. agent.memory_uses: one row per memory, run, and signal.
--
-- agent.memory_recalls stays. Recall still stamps each memory record it
-- serves there, and the curator's stale and contradiction checks read it
-- (ADR-238, ADR-245).

ALTER TABLE agent.memories
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'waiting',
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS memory_type text,
  ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_reason text,
  ADD COLUMN IF NOT EXISTS promoted_lineage text;

-- ── Backfill ──
-- agent.memories forces row-level security, so the update runs with the
-- bypass set for this transaction only. Settling a memory PR deleted every
-- memory it cited, so a memory that names an open memory PR is in that PR,
-- and every other memory is waiting.
SELECT set_config('app.rls_bypass', 'on', true);

UPDATE agent.memories AS m
SET state = 'in_pr'
FROM agent.memory_prs AS pr
WHERE m.memory_pr_id = pr.id AND pr.status = 'open';

SELECT set_config('app.rls_bypass', '', true);

ALTER TABLE agent.memories DROP CONSTRAINT IF EXISTS "memories_capture_check";
ALTER TABLE agent.memories ADD CONSTRAINT "memories_capture_check"
  CHECK (capture IN ('remember', 'pull_request', 'local_gateway', 'import'));
ALTER TABLE agent.memories ADD CONSTRAINT "memories_state_check"
  CHECK (state IN ('waiting', 'in_pr', 'promoted', 'dismissed', 'retired'));
ALTER TABLE agent.memories ADD CONSTRAINT "memories_retired_check"
  CHECK ((state = 'retired') = (retired_at IS NOT NULL) AND (state = 'retired') = (retired_reason IS NOT NULL) AND (retired_reason IS NULL OR retired_reason IN ('deleted', 'unused')));
ALTER TABLE agent.memories ADD CONSTRAINT "memories_promoted_check"
  CHECK (state <> 'promoted' OR promoted_lineage IS NOT NULL);
ALTER TABLE agent.memories ADD CONSTRAINT "memories_use_count_check"
  CHECK (use_count >= 0);
ALTER TABLE agent.memories ADD CONSTRAINT "memories_label_check"
  CHECK ((label IS NULL OR char_length(label) BETWEEN 1 AND 200) AND (summary IS NULL OR char_length(summary) BETWEEN 1 AND 1000) AND (memory_type IS NULL OR memory_type ~ '^[a-z][a-z0-9_-]{0,31}$'));

-- The waiting queue now reads `state`, not a missing memory PR.
DROP INDEX IF EXISTS agent.memories_waiting_idx;
CREATE INDEX IF NOT EXISTS memories_waiting_idx ON agent.memories (org_id, workspace_id, created_at) WHERE state = 'waiting';
-- A use and a scan find a memory by its source.
CREATE INDEX IF NOT EXISTS memories_source_idx ON agent.memories (workspace_id, source) WHERE source IS NOT NULL;

COMMENT ON COLUMN agent.memories.state IS
  'waiting, in_pr, promoted, dismissed, or retired (ADR-245).';
COMMENT ON COLUMN agent.memories.use_count IS
  'Distinct runs in agent.memory_uses, plus the count of its uses with no run. Written with the uses.';
COMMENT ON COLUMN agent.memories.promoted_lineage IS
  'The lineage of the steering record that carries the memory.';

CREATE TABLE IF NOT EXISTS agent.memory_uses (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL REFERENCES agent.memories (id) ON DELETE CASCADE,
  run_public_id text,
  signal text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  used_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "memory_uses_uq" UNIQUE NULLS NOT DISTINCT (memory_id, run_public_id, signal),
  CONSTRAINT "memory_uses_run_public_id_check" CHECK (run_public_id IS NULL OR run_public_id ~ '^(arun|tse)_[0-9a-z]+$'),
  CONSTRAINT "memory_uses_signal_check" CHECK (signal IN ('read', 'harness_count', 'citation')),
  CONSTRAINT "memory_uses_signal_run_check" CHECK (signal = 'harness_count' OR run_public_id IS NOT NULL),
  CONSTRAINT "memory_uses_count_check" CHECK (count >= 1)
);
CREATE INDEX IF NOT EXISTS memory_uses_memory_idx ON agent.memory_uses (memory_id, used_at);

ALTER TABLE agent.memory_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.memory_uses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.memory_uses;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.memory_uses;
CREATE POLICY tenant_isolation ON agent.memory_uses
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.memory_uses
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.memory_uses TO oxagen_app;
  END IF;
END $$;
