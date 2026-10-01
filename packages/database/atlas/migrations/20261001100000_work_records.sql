-- The Phase 1 work records (P1-02, #4897; ADR-237).
--
-- agent-work-phase-1.html, Data contract, names the objects: a work item with
-- a revision, a triage decision bound to that revision, an acceptance brief, a
-- work order, and an append-only history of delivery, review, merge, and
-- reopen. This migration adds them to the work schema C0 created
-- (20260929000000_work_schema.sql):
--
--   work.items             a revision, a concurrency version, the source
--                          digest and repository, the running and review
--                          states, and one work item per provider item in a
--                          workspace
--   work.triage_decisions  an unknown model or cost stays null, and the item
--                          revision triage read
--   work.briefs            immutable brief revisions (work-brief/v1)
--   work.orders            one send of one approved brief to one agent, with
--                          the send facts frozen and one open send per item
--                          and per agent
--   work.item_facts        the append-only history the item's state is
--                          reduced from
--
-- Nothing writes work.items in production yet, so every new NOT NULL column
-- has a default and no row needs a backfill. Each new table carries the
-- standard tenant policy pair, copied from the C0 migration. briefs and
-- item_facts are append only: oxagen_app may read and insert them, and a
-- trigger refuses an UPDATE from any role. triage_decisions and
-- triage_corrections become append only for oxagen_app.

-- ---------------------------------------------------------------------------
-- work.items
-- ---------------------------------------------------------------------------

ALTER TABLE work.items
  ADD COLUMN IF NOT EXISTS source_repository text,
  ADD COLUMN IF NOT EXISTS source_digest text,
  ADD COLUMN IF NOT EXISTS material_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

ALTER TABLE work.items DROP CONSTRAINT IF EXISTS "items_state_check";
ALTER TABLE work.items ADD CONSTRAINT "items_state_check"
  CHECK (state IN ('new', 'held', 'triaged', 'needs_info', 'changed', 'ready', 'sent', 'running', 'review', 'done', 'closed'));
ALTER TABLE work.items DROP CONSTRAINT IF EXISTS "items_source_digest_check";
ALTER TABLE work.items ADD CONSTRAINT "items_source_digest_check"
  CHECK (source_digest IS NULL OR source_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE work.items DROP CONSTRAINT IF EXISTS "items_material_revision_check";
ALTER TABLE work.items ADD CONSTRAINT "items_material_revision_check"
  CHECK (material_revision >= 1);
ALTER TABLE work.items DROP CONSTRAINT IF EXISTS "items_version_check";
ALTER TABLE work.items ADD CONSTRAINT "items_version_check"
  CHECK (version >= 0);

-- One source item is one work item in a workspace, whichever collector heard
-- it. items_provider_uniq (collector_id, provider_id) stays: it still keys a
-- collector with no connection. Soft-deleted rows keep their key.
CREATE UNIQUE INDEX IF NOT EXISTS items_source_uniq
  ON work.items (org_id, workspace_id, provider_id)
  WHERE provider_id IS NOT NULL;

-- An item's identity never changes, and its revision and version never go
-- back. Everything else stays writable for the collector and the store.
CREATE OR REPLACE FUNCTION work.items_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
  THEN
    RAISE EXCEPTION 'work.items: the identity of item % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.material_revision < OLD.material_revision OR NEW.version < OLD.version THEN
    RAISE EXCEPTION 'work.items: the revision or version of item % went back', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS items_guard ON work.items;
CREATE TRIGGER items_guard
  BEFORE UPDATE ON work.items
  FOR EACH ROW EXECUTE FUNCTION work.items_guard();

-- ---------------------------------------------------------------------------
-- work.triage_decisions
-- ---------------------------------------------------------------------------

-- An unknown model or cost stays unknown. A null is not a zero.
ALTER TABLE work.triage_decisions ALTER COLUMN model DROP NOT NULL;
ALTER TABLE work.triage_decisions ALTER COLUMN cost_usd DROP NOT NULL;
ALTER TABLE work.triage_decisions ALTER COLUMN cost_usd DROP DEFAULT;
ALTER TABLE work.triage_decisions ADD COLUMN IF NOT EXISTS item_revision integer;
ALTER TABLE work.triage_decisions DROP CONSTRAINT IF EXISTS "triage_decisions_item_revision_check";
ALTER TABLE work.triage_decisions ADD CONSTRAINT "triage_decisions_item_revision_check"
  CHECK (item_revision IS NULL OR item_revision >= 1);

-- ---------------------------------------------------------------------------
-- work.briefs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS work.briefs (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  item_id uuid NOT NULL CONSTRAINT "briefs_item_id_items_id_fk" REFERENCES work.items (id),
  revision integer NOT NULL,
  item_revision integer NOT NULL,
  body jsonb NOT NULL,
  digest text NOT NULL,
  author text NOT NULL,
  CONSTRAINT "briefs_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "briefs_revision_check" CHECK (revision >= 1),
  CONSTRAINT "briefs_item_revision_check" CHECK (item_revision >= 1),
  CONSTRAINT "briefs_digest_check" CHECK (digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS briefs_item_revision_uniq ON work.briefs (item_id, revision);
CREATE UNIQUE INDEX IF NOT EXISTS briefs_item_digest_key ON work.briefs (id, item_id, digest);
CREATE UNIQUE INDEX IF NOT EXISTS briefs_item_revision_key ON work.briefs (id, item_id, revision, digest);
ALTER TABLE work.briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.briefs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.briefs;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.briefs;
CREATE POLICY tenant_isolation ON work.briefs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.briefs
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- work.orders
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS work.orders (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  item_id uuid NOT NULL CONSTRAINT "orders_item_id_items_id_fk" REFERENCES work.items (id),
  item_revision integer NOT NULL,
  send integer NOT NULL,
  brief_id uuid NOT NULL,
  brief_revision integer NOT NULL,
  brief_digest text NOT NULL,
  idempotency_key text NOT NULL,
  agent_id uuid NOT NULL,
  runtime_id uuid NOT NULL,
  runtime_tier text NOT NULL,
  operator_id uuid NOT NULL,
  mandate_id uuid,
  repository text NOT NULL,
  budget_reservation_id uuid,
  released_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT "orders_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "orders_brief_fk" FOREIGN KEY (brief_id, item_id, brief_revision, brief_digest)
    REFERENCES work.briefs (id, item_id, revision, digest),
  CONSTRAINT "orders_send_check" CHECK (send >= 1),
  CONSTRAINT "orders_item_revision_check" CHECK (item_revision >= 1),
  CONSTRAINT "orders_runtime_tier_check" CHECK (runtime_tier IN ('contained', 'gateway', 'harness', 'observe')),
  CONSTRAINT "orders_closed_released_check" CHECK (closed_at IS NULL OR released_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_key_uniq ON work.orders (org_id, workspace_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS orders_item_send_uniq ON work.orders (item_id, send);
-- The atomic capacity claim: one open send per item, one unreleased send per agent.
CREATE UNIQUE INDEX IF NOT EXISTS orders_open_item_uniq ON work.orders (item_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_open_agent_uniq ON work.orders (org_id, workspace_id, agent_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_item_key ON work.orders (id, item_id);
ALTER TABLE work.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.orders;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.orders;
CREATE POLICY tenant_isolation ON work.orders
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.orders
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- A send's facts never change. released_at and closed_at each move once, from
-- null, and never back.
CREATE OR REPLACE FUNCTION work.orders_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.item_revision IS DISTINCT FROM OLD.item_revision
     OR NEW.send IS DISTINCT FROM OLD.send
     OR NEW.brief_id IS DISTINCT FROM OLD.brief_id
     OR NEW.brief_revision IS DISTINCT FROM OLD.brief_revision
     OR NEW.brief_digest IS DISTINCT FROM OLD.brief_digest
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.runtime_id IS DISTINCT FROM OLD.runtime_id
     OR NEW.runtime_tier IS DISTINCT FROM OLD.runtime_tier
     OR NEW.operator_id IS DISTINCT FROM OLD.operator_id
     OR NEW.mandate_id IS DISTINCT FROM OLD.mandate_id
     OR NEW.repository IS DISTINCT FROM OLD.repository
     OR NEW.budget_reservation_id IS DISTINCT FROM OLD.budget_reservation_id
  THEN
    RAISE EXCEPTION 'work.orders: the send facts of order % cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
     OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at)
  THEN
    RAISE EXCEPTION 'work.orders: order % was already released or closed', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_guard ON work.orders;
CREATE TRIGGER orders_guard
  BEFORE UPDATE ON work.orders
  FOR EACH ROW EXECUTE FUNCTION work.orders_guard();

-- ---------------------------------------------------------------------------
-- work.item_facts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS work.item_facts (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  item_id uuid NOT NULL CONSTRAINT "item_facts_item_id_items_id_fk" REFERENCES work.items (id),
  order_id uuid,
  kind text NOT NULL,
  source text NOT NULL,
  item_revision integer NOT NULL,
  brief_id uuid,
  brief_digest text,
  repository text,
  pr_number integer,
  head_sha text,
  run_id text,
  criterion_id text,
  actor text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  dedupe_key text NOT NULL,
  CONSTRAINT "item_facts_order_fk" FOREIGN KEY (order_id, item_id) REFERENCES work.orders (id, item_id),
  CONSTRAINT "item_facts_brief_fk" FOREIGN KEY (brief_id, item_id, brief_digest) REFERENCES work.briefs (id, item_id, digest),
  CONSTRAINT "item_facts_kind_check" CHECK (kind IN ('collected', 'entered', 'source_changed', 'triage_recorded', 'triage_failed', 'triage_overridden', 'brief_saved', 'brief_approved', 'closed', 'reopened', 'send_requested', 'send_delivered', 'send_rejected', 'send_withdrawn', 'claimed', 'run_linked', 'run_ended', 'stop_requested', 'stopped', 'pr_linked', 'head_observed', 'checks_required', 'check_observed', 'criterion_claimed', 'returned', 'accepted', 'merged', 'pr_closed')),
  CONSTRAINT "item_facts_source_check" CHECK (source IN ('provider', 'runtime', 'agent', 'person', 'oxagen')),
  CONSTRAINT "item_facts_order_check" CHECK ((kind IN ('send_requested', 'send_delivered', 'send_rejected', 'send_withdrawn', 'claimed', 'run_linked', 'run_ended', 'stop_requested', 'stopped', 'pr_linked', 'head_observed', 'checks_required', 'check_observed', 'criterion_claimed', 'returned', 'accepted', 'merged', 'pr_closed')) = (order_id IS NOT NULL)),
  CONSTRAINT "item_facts_brief_check" CHECK ((brief_id IS NULL) = (brief_digest IS NULL)),
  CONSTRAINT "item_facts_item_revision_check" CHECK (item_revision >= 1),
  CONSTRAINT "item_facts_head_sha_check" CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "item_facts_run_id_check" CHECK (run_id IS NULL OR run_id ~ '^(arun|tse)_[0-9a-z]+$'),
  CONSTRAINT "item_facts_pr_number_check" CHECK (pr_number IS NULL OR pr_number >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS item_facts_dedupe_uniq ON work.item_facts (item_id, dedupe_key);
CREATE INDEX IF NOT EXISTS item_facts_item_idx ON work.item_facts (item_id, item_revision, occurred_at);
CREATE INDEX IF NOT EXISTS item_facts_order_idx ON work.item_facts (order_id) WHERE order_id IS NOT NULL;
-- One approved brief per item revision, and one send request per order.
CREATE UNIQUE INDEX IF NOT EXISTS item_facts_approval_uniq ON work.item_facts (item_id, item_revision) WHERE kind = 'brief_approved';
CREATE UNIQUE INDEX IF NOT EXISTS item_facts_send_uniq ON work.item_facts (order_id) WHERE kind = 'send_requested';
ALTER TABLE work.item_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.item_facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.item_facts;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.item_facts;
CREATE POLICY tenant_isolation ON work.item_facts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.item_facts
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- A brief revision and a fact never change, whoever asks. A DELETE stays with
-- the owner role for retention, and oxagen_app holds no DELETE grant.
CREATE OR REPLACE FUNCTION work.refuse_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '%.%: a row is append only and cannot change', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS briefs_append_only ON work.briefs;
CREATE TRIGGER briefs_append_only
  BEFORE UPDATE ON work.briefs
  FOR EACH ROW EXECUTE FUNCTION work.refuse_update();

DROP TRIGGER IF EXISTS item_facts_append_only ON work.item_facts;
CREATE TRIGGER item_facts_append_only
  BEFORE UPDATE ON work.item_facts
  FOR EACH ROW EXECUTE FUNCTION work.refuse_update();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- oxagen_app reaches the new tables on an environment that replays
-- migrations in order. The blanket regrant covers only the schemas that
-- existed when it ran.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA work TO oxagen_app;
    GRANT SELECT, INSERT ON work.briefs TO oxagen_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON work.briefs FROM oxagen_app;
    GRANT SELECT, INSERT, UPDATE ON work.orders TO oxagen_app;
    REVOKE DELETE, TRUNCATE ON work.orders FROM oxagen_app;
    GRANT SELECT, INSERT ON work.item_facts TO oxagen_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON work.item_facts FROM oxagen_app;
    -- Agent-work-phase-1.html, Data contract: append triage decisions and
    -- corrections.
    REVOKE UPDATE, DELETE, TRUNCATE ON work.triage_decisions FROM oxagen_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON work.triage_corrections FROM oxagen_app;
  END IF;
END
$$;
