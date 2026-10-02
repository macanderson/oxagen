-- The forge schema (ADR-288): the pull requests a workspace's forges deliver,
-- the diff of each head commit, and the runs and work orders each belongs to.
--
-- forge.pull_requests holds one row per workspace and pull request, keyed on
-- the forge's repository id (stable across a rename) and the number. Every
-- pull_request delivery and every link a run records keeps it current.
--
-- forge.pull_request_revisions holds one row per head commit. The diff's
-- bytes live in object storage under a tenant-first key, and the row holds
-- the key, the sha256 and the size. oxagen_app may read, insert and update a
-- revision, so a revision recorded before a diff store existed can be filled
-- later, and may not delete one. The writer never changes a stored row.
--
-- forge.pull_request_runs and forge.pull_request_work_orders are the two
-- many-to-many links. A run is named by its public id (arun_ or tse_). A work
-- order is named by work.orders.id, with no foreign key across the schema.
--
-- Every table carries the org mixin and the standard tenant policy.

CREATE SCHEMA IF NOT EXISTS forge;

CREATE TABLE IF NOT EXISTS forge.pull_requests (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  host text NOT NULL,
  provider_repository_id text NOT NULL,
  repository text NOT NULL,
  number integer NOT NULL,
  url text NOT NULL,
  title text,
  author_login text,
  state text NOT NULL,
  draft boolean NOT NULL DEFAULT false,
  base_ref text,
  head_ref text,
  head_sha text NOT NULL,
  base_sha text,
  merge_commit_sha text,
  merged_at timestamptz,
  closed_at timestamptz,
  source_updated_at timestamptz,
  state_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pull_requests_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "pull_requests_provider_check" CHECK (provider IN ('github','gitlab')),
  CONSTRAINT "pull_requests_state_check" CHECK (state IN ('open','merged','closed')),
  CONSTRAINT "pull_requests_draft_check" CHECK (state = 'open' OR draft = false),
  CONSTRAINT "pull_requests_number_check" CHECK (number > 0),
  CONSTRAINT "pull_requests_sha_check" CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' AND (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$') AND (merge_commit_sha IS NULL OR merge_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'))
);
-- One row per workspace and pull request. The repository id survives a rename.
CREATE UNIQUE INDEX IF NOT EXISTS pull_requests_forge_uq ON forge.pull_requests (org_id, workspace_id, provider, host, provider_repository_id, number);
-- A recorded link names a URL, so it is matched on the path and the number.
CREATE INDEX IF NOT EXISTS pull_requests_path_idx ON forge.pull_requests (org_id, workspace_id, provider, repository, number);

COMMENT ON TABLE forge.pull_requests IS
  'The pull requests a workspace''s forges deliver, kept current by every delivery and link (ADR-288).';
COMMENT ON COLUMN forge.pull_requests.provider_repository_id IS
  'GitHub''s repository id or GitLab''s project id: immutable across renames.';
COMMENT ON COLUMN forge.pull_requests.source_updated_at IS
  'The forge''s own updated_at. A write older than the one held never replaces it.';

CREATE TABLE IF NOT EXISTS forge.pull_request_revisions (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  pull_request_id uuid NOT NULL REFERENCES forge.pull_requests (id) ON DELETE CASCADE,
  head_sha text NOT NULL,
  base_sha text,
  merge_base_sha text,
  diff_status text NOT NULL,
  diff_store text,
  diff_key text,
  diff_sha256 text,
  diff_bytes bigint,
  files_changed integer,
  additions integer,
  deletions integer,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  complete boolean NOT NULL DEFAULT false,
  limitations text[] NOT NULL DEFAULT '{}',
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pull_request_revisions_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "pull_request_revisions_status_check" CHECK (diff_status IN ('stored','too_large','unreadable','unconfigured')),
  CONSTRAINT "pull_request_revisions_stored_check" CHECK ((diff_status = 'stored') = (diff_key IS NOT NULL AND diff_store IS NOT NULL AND diff_sha256 IS NOT NULL AND diff_bytes IS NOT NULL)),
  CONSTRAINT "pull_request_revisions_digest_check" CHECK (diff_sha256 IS NULL OR diff_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pull_request_revisions_sha_check" CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' AND (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$') AND (merge_base_sha IS NULL OR merge_base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'))
);
-- One row per head commit. The base branch's tip moves on every delivery while
-- the diff from the merge base stays the same, so the base is not in the key.
CREATE UNIQUE INDEX IF NOT EXISTS pull_request_revisions_head_uq ON forge.pull_request_revisions (pull_request_id, head_sha);
CREATE INDEX IF NOT EXISTS pull_request_revisions_captured_idx ON forge.pull_request_revisions (org_id, workspace_id, pull_request_id, captured_at);

COMMENT ON TABLE forge.pull_request_revisions IS
  'One row per pull request head commit, naming the stored diff and its sha256 (ADR-288).';
COMMENT ON COLUMN forge.pull_request_revisions.diff_status IS
  'stored, too_large (the forge refused or it was over the cap), unreadable (403/404/410), or unconfigured (no diff store).';
COMMENT ON COLUMN forge.pull_request_revisions.complete IS
  'True when the stored bytes hold every file''s change in full.';

CREATE TABLE IF NOT EXISTS forge.pull_request_runs (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  pull_request_id uuid NOT NULL REFERENCES forge.pull_requests (id) ON DELETE CASCADE,
  run_id text NOT NULL,
  source text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pull_request_runs_run_check" CHECK (run_id ~ '^(arun|tse)_[0-9a-z]+$'),
  CONSTRAINT "pull_request_runs_source_check" CHECK (source IN ('opened','recorded'))
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_request_runs_link_uq ON forge.pull_request_runs (pull_request_id, run_id);
CREATE INDEX IF NOT EXISTS pull_request_runs_run_idx ON forge.pull_request_runs (org_id, workspace_id, run_id);

COMMENT ON TABLE forge.pull_request_runs IS
  'Which runs each pull request belongs to: many to many (ADR-288).';

CREATE TABLE IF NOT EXISTS forge.pull_request_work_orders (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  pull_request_id uuid NOT NULL REFERENCES forge.pull_requests (id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL,
  run_id text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pull_request_work_orders_run_check" CHECK (run_id IS NULL OR run_id ~ '^(arun|tse)_[0-9a-z]+$')
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_request_work_orders_link_uq ON forge.pull_request_work_orders (pull_request_id, work_order_id);
CREATE INDEX IF NOT EXISTS pull_request_work_orders_order_idx ON forge.pull_request_work_orders (org_id, workspace_id, work_order_id);

COMMENT ON TABLE forge.pull_request_work_orders IS
  'Which work orders each pull request belongs to: many to many (ADR-288).';
COMMENT ON COLUMN forge.pull_request_work_orders.work_order_id IS
  'work.orders.id, with no foreign key across the schema boundary.';

ALTER TABLE forge.pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge.pull_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON forge.pull_requests;
DROP POLICY IF EXISTS tenant_org_wide_read ON forge.pull_requests;
CREATE POLICY tenant_isolation ON forge.pull_requests
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON forge.pull_requests
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE forge.pull_request_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge.pull_request_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON forge.pull_request_revisions;
DROP POLICY IF EXISTS tenant_org_wide_read ON forge.pull_request_revisions;
CREATE POLICY tenant_isolation ON forge.pull_request_revisions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON forge.pull_request_revisions
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE forge.pull_request_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge.pull_request_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON forge.pull_request_runs;
DROP POLICY IF EXISTS tenant_org_wide_read ON forge.pull_request_runs;
CREATE POLICY tenant_isolation ON forge.pull_request_runs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON forge.pull_request_runs
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE forge.pull_request_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge.pull_request_work_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON forge.pull_request_work_orders;
DROP POLICY IF EXISTS tenant_org_wide_read ON forge.pull_request_work_orders;
CREATE POLICY tenant_isolation ON forge.pull_request_work_orders
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON forge.pull_request_work_orders
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- oxagen_app reaches the new schema on an environment that replays
-- migrations in order. The blanket regrant covers only the schemas that
-- existed when it ran.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA forge TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON forge.pull_requests TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE ON forge.pull_request_revisions TO oxagen_app;
    REVOKE DELETE, TRUNCATE ON forge.pull_request_revisions FROM oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON forge.pull_request_runs TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON forge.pull_request_work_orders TO oxagen_app;
  END IF;
END $$;
