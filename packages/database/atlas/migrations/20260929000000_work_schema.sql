-- The work schema (C0, #4735): work items, the collectors that bring them
-- in, triage, done records, and autonomy.
--
-- agent-work-spec.html, Storage, names these ten tables and their key
-- columns. Each table carries the org mixin and the standard tenant policy:
-- tenant_isolation for the current org and workspace, and
-- tenant_org_wide_read for an org-wide read. work.done_verdicts and
-- work.autonomy_events are append only, so oxagen_app may read and insert
-- them and nothing else.
--
-- work.triage_decisions.item_id carries a foreign key to work.items.
-- work.items.triage_id points back and carries only an index, so neither
-- insert waits on the other. Work orders and tasks.work_order_bindings stay
-- as work-in-flight-spec.md §9 names them. No tasks schema exists yet, so
-- this migration creates neither.

CREATE SCHEMA IF NOT EXISTS work;

CREATE TABLE IF NOT EXISTS work.collectors (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  updated_by_id uuid,
  name text NOT NULL,
  type text NOT NULL,
  connection_id uuid,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  health text NOT NULL DEFAULT 'healthy',
  cursor text,
  file_hash text NOT NULL,
  CONSTRAINT "collectors_type_check" CHECK (type IN ('github', 'jira', 'linear', 'zendesk', 'servicenow', 'salesforce', 'slack', 'email')),
  CONSTRAINT "collectors_health_check" CHECK (health IN ('healthy', 'lagging', 'failing', 'paused'))
);
CREATE UNIQUE INDEX IF NOT EXISTS collectors_name_uniq ON work.collectors (org_id, workspace_id, name);
ALTER TABLE work.collectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.collectors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.collectors;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.collectors;
CREATE POLICY tenant_isolation ON work.collectors
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.collectors
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.inbound_events (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  collector_id uuid NOT NULL REFERENCES work.collectors (id),
  delivery_id text NOT NULL,
  cloudevent jsonb NOT NULL,
  raw_ref text,
  processed_at timestamptz,
  outcome text
);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_events_delivery_uniq ON work.inbound_events (collector_id, delivery_id);
CREATE INDEX IF NOT EXISTS inbound_events_unprocessed_idx ON work.inbound_events (collector_id, created_at) WHERE processed_at IS NULL;
ALTER TABLE work.inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.inbound_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.inbound_events;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.inbound_events;
CREATE POLICY tenant_isolation ON work.inbound_events
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.inbound_events
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.items (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  updated_by_id uuid,
  number text NOT NULL,
  subject text NOT NULL,
  description text,
  labels text[] NOT NULL DEFAULT '{}',
  owner text,
  source_created_by text,
  source_created_at timestamptz,
  source_updated_by text,
  source_updated_at timestamptz,
  closed_at timestamptz,
  status text NOT NULL DEFAULT 'Open',
  status_category text NOT NULL DEFAULT 'open',
  resolution text,
  provider_id text,
  source_url text,
  priority text,
  priority_raw text,
  estimate_minutes integer,
  planning_priority jsonb,
  collector_id uuid REFERENCES work.collectors (id),
  origin text NOT NULL,
  requester text,
  tainted text[] NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'new',
  held_reason text,
  triage_id uuid,
  done_record_digest text,
  duplicate_of uuid,
  level_at_send smallint,
  CONSTRAINT "items_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "items_duplicate_of_fk" FOREIGN KEY (duplicate_of) REFERENCES work.items (id),
  CONSTRAINT "items_origin_check" CHECK (origin IN ('provider', 'email', 'slack', 'csv', 'manual')),
  CONSTRAINT "items_state_check" CHECK (state IN ('new', 'held', 'triaged', 'needs_info', 'changed', 'ready', 'sent', 'done', 'closed')),
  CONSTRAINT "items_status_category_check" CHECK (status_category IN ('open', 'blocked', 'closed')),
  CONSTRAINT "items_estimate_check" CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0),
  CONSTRAINT "items_level_at_send_check" CHECK (level_at_send IS NULL OR level_at_send BETWEEN 0 AND 3),
  CONSTRAINT "items_done_record_digest_check" CHECK (done_record_digest IS NULL OR done_record_digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS items_number_uniq ON work.items (org_id, workspace_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS items_provider_uniq ON work.items (collector_id, provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_state_idx ON work.items (org_id, workspace_id, state);
CREATE INDEX IF NOT EXISTS items_triage_idx ON work.items (triage_id);
ALTER TABLE work.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.items;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.items;
CREATE POLICY tenant_isolation ON work.items
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.items
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.item_links (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  from_id uuid NOT NULL REFERENCES work.items (id),
  to_id uuid NOT NULL REFERENCES work.items (id),
  kind text NOT NULL,
  "by" text NOT NULL,
  CONSTRAINT "item_links_kind_check" CHECK (kind IN ('blocks', 'duplicates', 'related', 'caused_by')),
  CONSTRAINT "item_links_self_check" CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS item_links_uniq ON work.item_links (from_id, to_id, kind);
CREATE INDEX IF NOT EXISTS item_links_to_idx ON work.item_links (to_id);
ALTER TABLE work.item_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.item_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.item_links;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.item_links;
CREATE POLICY tenant_isolation ON work.item_links
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.item_links
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.triage_decisions (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  item_id uuid NOT NULL REFERENCES work.items (id),
  output jsonb NOT NULL,
  model text NOT NULL,
  prompt_digest text NOT NULL,
  priorities_hash text NOT NULL,
  input_digest text NOT NULL,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  CONSTRAINT "triage_decisions_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "triage_decisions_cost_check" CHECK (cost_usd >= 0)
);
CREATE INDEX IF NOT EXISTS triage_decisions_item_idx ON work.triage_decisions (item_id, created_at);
ALTER TABLE work.triage_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.triage_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.triage_decisions;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.triage_decisions;
CREATE POLICY tenant_isolation ON work.triage_decisions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.triage_decisions
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.triage_corrections (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  decision_id uuid NOT NULL REFERENCES work.triage_decisions (id),
  field text NOT NULL,
  before jsonb,
  after jsonb,
  "by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS triage_corrections_decision_idx ON work.triage_corrections (decision_id);
ALTER TABLE work.triage_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.triage_corrections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.triage_corrections;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.triage_corrections;
CREATE POLICY tenant_isolation ON work.triage_corrections
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.triage_corrections
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.done_records (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  digest text NOT NULL,
  item_id uuid NOT NULL REFERENCES work.items (id),
  body jsonb NOT NULL,
  drafted_by_model text,
  locked_by text NOT NULL,
  locked_at timestamptz NOT NULL,
  CONSTRAINT "done_records_digest_check" CHECK (digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS done_records_digest_uniq ON work.done_records (org_id, workspace_id, digest);
CREATE INDEX IF NOT EXISTS done_records_item_idx ON work.done_records (item_id);
ALTER TABLE work.done_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.done_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.done_records;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.done_records;
CREATE POLICY tenant_isolation ON work.done_records
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.done_records
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.done_verdicts (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  record_digest text NOT NULL,
  verdict text NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}',
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  stage_models jsonb NOT NULL DEFAULT '{}'::jsonb,
  attestation_ref text,
  commit_sha text,
  CONSTRAINT "done_verdicts_verdict_check" CHECK (verdict IN ('pending', 'held', 'proven', 'broken')),
  CONSTRAINT "done_verdicts_reasons_check" CHECK (reasons <@ ARRAY['CHECK_FAILED', 'TOOL_DENIED', 'BUDGET_EXCEEDED', 'ATTEMPTS_EXHAUSTED', 'LOCK_MISMATCH', 'EVIDENCE_INVALID', 'HUMAN_PENDING', 'HARNESS_ERROR']::text[]),
  CONSTRAINT "done_verdicts_record_digest_check" CHECK (record_digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS done_verdicts_record_idx ON work.done_verdicts (org_id, workspace_id, record_digest, created_at);
ALTER TABLE work.done_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.done_verdicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.done_verdicts;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.done_verdicts;
CREATE POLICY tenant_isolation ON work.done_verdicts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.done_verdicts
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.autonomy_events (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  scope jsonb NOT NULL,
  from_level smallint,
  to_level smallint NOT NULL,
  cause text NOT NULL,
  "by" text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "autonomy_events_from_level_check" CHECK (from_level IS NULL OR from_level BETWEEN 0 AND 3),
  CONSTRAINT "autonomy_events_to_level_check" CHECK (to_level BETWEEN 0 AND 3),
  CONSTRAINT "autonomy_events_cause_check" CHECK (cause IN ('steering_pr', 'revert', 'escaped_defect', 'sample_rejected'))
);
CREATE INDEX IF NOT EXISTS autonomy_events_created_idx ON work.autonomy_events (org_id, workspace_id, created_at);
ALTER TABLE work.autonomy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.autonomy_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.autonomy_events;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.autonomy_events;
CREATE POLICY tenant_isolation ON work.autonomy_events
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.autonomy_events
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS work.training_exports (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  consent_hash text NOT NULL,
  count integer NOT NULL,
  positive integer NOT NULL,
  negative integer NOT NULL,
  object_ref text,
  digest text NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT "training_exports_counts_check" CHECK (count >= 0 AND positive >= 0 AND negative >= 0 AND positive + negative <= count)
);
CREATE INDEX IF NOT EXISTS training_exports_created_idx ON work.training_exports (org_id, workspace_id, created_at);
ALTER TABLE work.training_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.training_exports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.training_exports;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.training_exports;
CREATE POLICY tenant_isolation ON work.training_exports
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.training_exports
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- oxagen_app reaches the new schema on an environment that replays
-- migrations in order. The blanket regrant covers only the schemas that
-- existed when it ran.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA work TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON work.collectors TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON work.inbound_events TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON work.items TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON work.item_links TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON work.triage_decisions TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON work.triage_corrections TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON work.done_records TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON work.training_exports TO oxagen_app;
    GRANT SELECT, INSERT ON work.done_verdicts TO oxagen_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON work.done_verdicts FROM oxagen_app;
    GRANT SELECT, INSERT ON work.autonomy_events TO oxagen_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON work.autonomy_events FROM oxagen_app;
  END IF;
END
$$;
