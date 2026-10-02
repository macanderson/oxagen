-- Work order capture (lane F13, #4638): the capture half of build step 10 of
-- the spend spec (wasted-spend.html, Operator productivity, Capture needed).
--
-- Every run has a parent work order. A send in work.orders (ADR-244) needs a
-- work item and an approved brief, so a run an operator starts outside Oxagen
-- cannot have one. This migration adds:
--
--   work.direct_orders   one direct work order per run that no send covers:
--                        its operator, its agent, the run, when it opened,
--                        and the work item it was attached to and when
--   work.done_checks     one row per check run of a definition of done (a
--                        decide over the work order's done record), with its
--                        work order, verdict, result, and time
--   cost.run_totals      work_order_id and work_order_kind: the send or the
--                        direct work order the run belongs to
--   work.item_facts      an index on the run a run_linked fact names, which
--                        the rollup reads to find a run's send
--
-- work.orders stays as ADR-244 defines it. Both new tables carry the standard
-- tenant policy pair, copied from 20261002030300_work_records.sql. The rollup
-- writes run_totals and direct orders outside a tenant scope, as it already
-- does for run_totals.

-- ---------------------------------------------------------------------------
-- work.direct_orders
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS work.direct_orders (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id text NOT NULL,
  operator_principal_id uuid,
  agent_principal_id uuid,
  opened_at timestamptz NOT NULL,
  item_id uuid CONSTRAINT "direct_orders_item_id_items_id_fk" REFERENCES work.items (id),
  attached_at timestamptz,
  attached_by text,
  CONSTRAINT "direct_orders_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "direct_orders_run_id_check" CHECK (run_id ~ '^(arun|tse)_[0-9a-z]+$'),
  CONSTRAINT "direct_orders_attached_check" CHECK ((item_id IS NULL) = (attached_at IS NULL) AND (item_id IS NULL) = (attached_by IS NULL))
);
-- One direct work order per run. A run's public id is unique across tenants,
-- as cost.run_totals.run_id is.
CREATE UNIQUE INDEX IF NOT EXISTS direct_orders_run_uniq ON work.direct_orders (run_id);
CREATE INDEX IF NOT EXISTS direct_orders_opened_idx ON work.direct_orders (org_id, workspace_id, opened_at);
CREATE INDEX IF NOT EXISTS direct_orders_item_idx ON work.direct_orders (item_id) WHERE item_id IS NOT NULL;
ALTER TABLE work.direct_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.direct_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.direct_orders;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.direct_orders;
CREATE POLICY tenant_isolation ON work.direct_orders
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.direct_orders
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- What a direct work order covers never changes. The work item, the time it
-- was attached, and who attached it move together, once, from null. The work
-- item must be in the direct work order's org and workspace: a foreign key
-- ignores row security, so it alone would accept another tenant's item.
CREATE OR REPLACE FUNCTION work.direct_orders_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.public_id IS DISTINCT FROM OLD.public_id
       OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.operator_principal_id IS DISTINCT FROM OLD.operator_principal_id
       OR NEW.agent_principal_id IS DISTINCT FROM OLD.agent_principal_id
       OR NEW.opened_at IS DISTINCT FROM OLD.opened_at)
  THEN
    RAISE EXCEPTION 'work.direct_orders: the run that direct work order % covers cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.item_id IS NOT NULL AND (
       NEW.item_id IS DISTINCT FROM OLD.item_id
       OR NEW.attached_at IS DISTINCT FROM OLD.attached_at
       OR NEW.attached_by IS DISTINCT FROM OLD.attached_by)
  THEN
    RAISE EXCEPTION 'work.direct_orders: direct work order % is already attached to a work item', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.item_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM work.items i
       WHERE i.id = NEW.item_id
         AND i.org_id = NEW.org_id
         AND i.workspace_id = NEW.workspace_id)
  THEN
    RAISE EXCEPTION 'work.direct_orders: work item % is not in the workspace of direct work order %', NEW.item_id, NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS direct_orders_guard ON work.direct_orders;
CREATE TRIGGER direct_orders_guard
  BEFORE INSERT OR UPDATE ON work.direct_orders
  FOR EACH ROW EXECUTE FUNCTION work.direct_orders_guard();

-- ---------------------------------------------------------------------------
-- work.done_checks
-- ---------------------------------------------------------------------------

-- One check run of a definition of done: each time decide runs over a work
-- order's done record. held and proven pass, broken fails, and pending has
-- not decided yet. One row per stage session, so a retried step adds none.
CREATE TABLE IF NOT EXISTS work.done_checks (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  order_id uuid NOT NULL CONSTRAINT "done_checks_order_id_orders_id_fk" REFERENCES work.orders (id),
  record_digest text NOT NULL,
  verdict text NOT NULL,
  result text NOT NULL,
  checked_at timestamptz NOT NULL,
  session_id text NOT NULL,
  role text NOT NULL,
  CONSTRAINT "done_checks_record_digest_check" CHECK (record_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "done_checks_verdict_check" CHECK (verdict IN ('pending', 'held', 'proven', 'broken')),
  CONSTRAINT "done_checks_result_check" CHECK (result = CASE verdict WHEN 'held' THEN 'passed' WHEN 'proven' THEN 'passed' WHEN 'broken' THEN 'failed' ELSE 'pending' END)
);
CREATE UNIQUE INDEX IF NOT EXISTS done_checks_session_uniq ON work.done_checks (order_id, session_id);
CREATE INDEX IF NOT EXISTS done_checks_checked_idx ON work.done_checks (org_id, workspace_id, checked_at);
ALTER TABLE work.done_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.done_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.done_checks;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.done_checks;
CREATE POLICY tenant_isolation ON work.done_checks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.done_checks
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- A check run never changes, whoever asks (work.refuse_update, from the work
-- records migration).
DROP TRIGGER IF EXISTS done_checks_append_only ON work.done_checks;
CREATE TRIGGER done_checks_append_only
  BEFORE UPDATE ON work.done_checks
  FOR EACH ROW EXECUTE FUNCTION work.refuse_update();

-- ---------------------------------------------------------------------------
-- work.item_facts
-- ---------------------------------------------------------------------------

-- The rollup finds the send a run belongs to by the run_linked fact that
-- names it.
CREATE INDEX IF NOT EXISTS item_facts_run_linked_idx ON work.item_facts (run_id)
  WHERE kind = 'run_linked';

-- ---------------------------------------------------------------------------
-- cost.run_totals
-- ---------------------------------------------------------------------------

-- The work order the run belongs to: a send (work.orders.id) or a direct work
-- order (work.direct_orders.id). No foreign key, because the id names a row in
-- one of two tables, and work_order_kind says which. Null on a row the rollup
-- wrote before this column existed, until the run is rolled up again.
ALTER TABLE cost.run_totals
  ADD COLUMN IF NOT EXISTS work_order_id uuid,
  ADD COLUMN IF NOT EXISTS work_order_kind text;
ALTER TABLE cost.run_totals DROP CONSTRAINT IF EXISTS "run_totals_work_order_kind_check";
ALTER TABLE cost.run_totals ADD CONSTRAINT "run_totals_work_order_kind_check"
  CHECK (work_order_kind IS NULL OR work_order_kind IN ('send', 'direct'));
ALTER TABLE cost.run_totals DROP CONSTRAINT IF EXISTS "run_totals_work_order_pair_check";
ALTER TABLE cost.run_totals ADD CONSTRAINT "run_totals_work_order_pair_check"
  CHECK ((work_order_id IS NULL) = (work_order_kind IS NULL));
CREATE INDEX IF NOT EXISTS run_totals_work_order_idx ON cost.run_totals (work_order_id)
  WHERE work_order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA work TO oxagen_app;
    -- The attach is the one UPDATE, and the guard trigger limits it.
    GRANT SELECT, INSERT, UPDATE ON work.direct_orders TO oxagen_app;
    REVOKE DELETE, TRUNCATE ON work.direct_orders FROM oxagen_app;
    GRANT SELECT, INSERT ON work.done_checks TO oxagen_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON work.done_checks FROM oxagen_app;
  END IF;
END
$$;
