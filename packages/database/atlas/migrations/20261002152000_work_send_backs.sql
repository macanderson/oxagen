-- Send-back notes (lane R3, #5108): the record that keeps each send-back note
-- from posting twice.
--
-- F34 (#5085) sends a work order back to its work item when its last runs
-- each ended with nothing kept. sendBackWorkOrders in
-- @oxagen/ingestion/collectors posts one note on the work item through
-- write-back, and records the streak once the note is written. A streak is the
-- work order and the newest run in it, so a later pass that finds the same
-- streak posts nothing, and a new run starts a new streak.
--
--   work.send_backs   one row per note posted: the work order and the newest
--                     run of the streak it named
--
-- A row is written only when the note was written. A switch that is off, a
-- paused collector, or a provider with no write-back writes no row, so a later
-- pass tries again. The table carries the standard tenant policy pair, copied
-- from 20261002063000_work_direct_orders.sql, and is append only.

CREATE TABLE IF NOT EXISTS work.send_backs (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  order_id uuid NOT NULL CONSTRAINT "send_backs_order_id_orders_id_fk" REFERENCES work.orders (id),
  last_run_id text NOT NULL,
  CONSTRAINT "send_backs_last_run_id_check" CHECK (last_run_id ~ '^(arun|tse)_[0-9a-z]+$')
);
-- One note per streak. A second insert of the same streak does nothing.
CREATE UNIQUE INDEX IF NOT EXISTS send_backs_streak_uniq ON work.send_backs (order_id, last_run_id);
CREATE INDEX IF NOT EXISTS send_backs_created_idx ON work.send_backs (org_id, workspace_id, created_at);
ALTER TABLE work.send_backs ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.send_backs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work.send_backs;
DROP POLICY IF EXISTS tenant_org_wide_read ON work.send_backs;
CREATE POLICY tenant_isolation ON work.send_backs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON work.send_backs
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- A posted note never changes, whoever asks (work.refuse_update, from the work
-- records migration).
DROP TRIGGER IF EXISTS send_backs_append_only ON work.send_backs;
CREATE TRIGGER send_backs_append_only
  BEFORE UPDATE ON work.send_backs
  FOR EACH ROW EXECUTE FUNCTION work.refuse_update();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA work TO oxagen_app;
    GRANT SELECT, INSERT ON work.send_backs TO oxagen_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON work.send_backs FROM oxagen_app;
  END IF;
END
$$;
