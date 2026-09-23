-- Widen tier constraints before exposing the receipt table used as readiness marker.
ALTER TABLE tacho.sessions DROP CONSTRAINT IF EXISTS tacho_sessions_tier_check;
ALTER TABLE tacho.sessions ADD CONSTRAINT "tacho_sessions_tier_check" CHECK (enforcement_tier IN ('contained', 'gateway', 'harness', 'observe'));
ALTER TABLE agent.agent_run_attempt_seals DROP CONSTRAINT IF EXISTS agent_run_attempt_seals_enforcement_tier_check;
ALTER TABLE agent.agent_run_attempt_seals ADD CONSTRAINT "agent_run_attempt_seals_enforcement_tier_check" CHECK (enforcement_tier IS NULL OR enforcement_tier IN ('contained', 'gateway', 'harness', 'observe'));
ALTER TABLE cost.run_totals DROP CONSTRAINT IF EXISTS run_totals_tier_check;
ALTER TABLE cost.run_totals ADD CONSTRAINT "run_totals_tier_check" CHECK (enforcement_tier IS NULL OR enforcement_tier IN ('contained', 'gateway', 'harness', 'observe'));

CREATE TABLE IF NOT EXISTS tacho.contained_launches (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  host_id uuid NOT NULL,
  session_uuid uuid NOT NULL,
  genesis_hash text NOT NULL,
  measurement jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contained_launches_public_id_unique UNIQUE(public_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tacho_contained_launches_host_session_uniq ON tacho.contained_launches (host_id, session_uuid);
ALTER TABLE tacho.contained_launches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.contained_launches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.contained_launches;
DROP POLICY IF EXISTS tenant_org_wide_read ON tacho.contained_launches;
CREATE POLICY tenant_isolation ON tacho.contained_launches
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON tacho.contained_launches
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT ON tacho.contained_launches TO oxagen_app;
  END IF;
END $$;
