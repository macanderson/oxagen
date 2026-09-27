-- Memories, reflections, and memory PRs (S6, #4458, ADR-206).
--
-- 1. agent.memory_reflections: the reflection/v1 an agent wrote at the end of
--    a run, or the one Oxagen wrote from the run's digest. One per run.
-- 2. agent.memory_prs: each memory PR the curator opened, and the steering
--    records it proposed.
-- 3. agent.memories: memory/v1 lessons waiting for the curator. Oxagen deletes
--    each one when the memory PR that cites it merges or closes.
-- 4. agent.memory_rejections: a hash of each statement whose record did not
--    merge, so the curator does not propose it again without new evidence.
-- 5. agent.memory_recalls: how often, and when last, a run recalled each
--    steering record, and when a person last decided on it. Retirement
--    reads it.
--
-- Every table is tenant-isolated like every org-scoped table.

CREATE TABLE IF NOT EXISTS agent.memory_reflections (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_public_id text NOT NULL,
  agent_lineage text,
  source text NOT NULL,
  outcome text NOT NULL,
  summary text NOT NULL,
  grades jsonb NOT NULL,
  lessons jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_feedback jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_reflections_public_id_unique UNIQUE(public_id),
  CONSTRAINT "memory_reflections_run_public_id_check" CHECK (run_public_id ~ '^(arun|tse)_[0-9a-z]+$'),
  CONSTRAINT "memory_reflections_source_check" CHECK (source IN ('agent', 'digest')),
  CONSTRAINT "memory_reflections_summary_check" CHECK (summary <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_reflections_run_uq ON agent.memory_reflections (workspace_id, run_public_id);
CREATE INDEX IF NOT EXISTS memory_reflections_created_idx ON agent.memory_reflections (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS agent.memory_prs (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  repository text NOT NULL,
  branch text NOT NULL,
  number integer NOT NULL,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  records jsonb NOT NULL DEFAULT '[]'::jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT memory_prs_public_id_unique UNIQUE(public_id),
  CONSTRAINT "memory_prs_status_check" CHECK (status IN ('open', 'merged', 'closed')),
  CONSTRAINT "memory_prs_settled_check" CHECK ((status = 'open') = (settled_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_prs_pr_uq ON agent.memory_prs (workspace_id, repository, number);
CREATE INDEX IF NOT EXISTS memory_prs_open_idx ON agent.memory_prs (org_id, workspace_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS agent.memories (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  agent_lineage text,
  run_public_id text,
  capture text NOT NULL,
  statement text NOT NULL,
  statement_hash text NOT NULL,
  kind text NOT NULL DEFAULT 'memory',
  repos jsonb,
  applies_to jsonb,
  tools jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text,
  dedupe_key text NOT NULL,
  reflection_id uuid REFERENCES agent.memory_reflections (id) ON DELETE SET NULL,
  memory_pr_id uuid REFERENCES agent.memory_prs (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memories_public_id_unique UNIQUE(public_id),
  CONSTRAINT "memories_capture_check" CHECK (capture IN ('remember', 'pull_request', 'local_gateway')),
  CONSTRAINT "memories_capture_pairing_check" CHECK ((capture <> 'remember' OR (run_public_id IS NOT NULL AND agent_lineage IS NOT NULL)) AND (capture <> 'local_gateway' OR run_public_id IS NULL)),
  CONSTRAINT "memories_run_public_id_check" CHECK (run_public_id IS NULL OR run_public_id ~ '^(arun|tse)_[0-9a-z]+$'),
  CONSTRAINT "memories_statement_check" CHECK (statement <> '' AND char_length(statement) <= 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_dedupe_uq ON agent.memories (workspace_id, dedupe_key);
CREATE INDEX IF NOT EXISTS memories_waiting_idx ON agent.memories (org_id, workspace_id, created_at) WHERE memory_pr_id IS NULL;
CREATE INDEX IF NOT EXISTS memories_pr_idx ON agent.memories (memory_pr_id);

CREATE TABLE IF NOT EXISTS agent.memory_rejections (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  statement_hash text NOT NULL,
  memory_pr_id uuid,
  rejected_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_rejections_hash_uq ON agent.memory_rejections (workspace_id, statement_hash);

CREATE TABLE IF NOT EXISTS agent.memory_recalls (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  lineage text NOT NULL,
  recall_count integer NOT NULL DEFAULT 0,
  last_recalled_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_recalls_lineage_uq ON agent.memory_recalls (workspace_id, lineage);

ALTER TABLE agent.memory_reflections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.memory_reflections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.memory_reflections;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.memory_reflections;
CREATE POLICY tenant_isolation ON agent.memory_reflections
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.memory_reflections
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE agent.memory_prs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.memory_prs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.memory_prs;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.memory_prs;
CREATE POLICY tenant_isolation ON agent.memory_prs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.memory_prs
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE agent.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.memories;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.memories;
CREATE POLICY tenant_isolation ON agent.memories
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.memories
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE agent.memory_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.memory_rejections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.memory_rejections;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.memory_rejections;
CREATE POLICY tenant_isolation ON agent.memory_rejections
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.memory_rejections
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE agent.memory_recalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.memory_recalls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.memory_recalls;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.memory_recalls;
CREATE POLICY tenant_isolation ON agent.memory_recalls
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.memory_recalls
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.memory_reflections TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.memory_prs TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.memories TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.memory_rejections TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE ON agent.memory_recalls TO oxagen_app;
  END IF;
END $$;
