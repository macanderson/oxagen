-- 0031_workspace_memory_policy.sql
--
-- Creates the workspace.workspace_memory_policy table for per-workspace memory
-- decay policies (OXA-1374). One row per workspace; rows are created on first
-- write via agent.memory.policy.write — callers fall back to defaults when absent.
--
-- RLS uses the standard bypass-aware tenant isolation policy (mirrors 0028).
-- Forward migration — immutable after merge (OXA-1515 policy).
BEGIN;

CREATE TABLE IF NOT EXISTS workspace.workspace_memory_policy (
  id               uuid        PRIMARY KEY DEFAULT COALESCE(
                     CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                       THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                     uuid_generate_v4()),
  org_id           uuid        NOT NULL,
  workspace_id     uuid        NOT NULL,
  half_life_low_days  integer  NOT NULL DEFAULT 30,
  half_life_high_days integer  NOT NULL DEFAULT 90,
  recall_threshold real        NOT NULL DEFAULT 0.1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_memory_policy_workspace_idx
  ON workspace.workspace_memory_policy (workspace_id);

CREATE INDEX IF NOT EXISTS workspace_memory_policy_org_workspace_idx
  ON workspace.workspace_memory_policy (org_id, workspace_id);

-- ── Row-level security: standard bypass-aware tenant isolation (mirrors 0028) ──
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace.workspace_memory_policy'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($pol$
      CREATE POLICY tenant_isolation ON %s
        USING (current_setting('app.rls_bypass', true) = 'on'
          OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
              AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
        WITH CHECK (current_setting('app.rls_bypass', true) = 'on'
          OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
              AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
    $pol$, t);
  END LOOP;

  -- oxagen_app grants (non-superuser app role; only when provisioned).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.workspace_memory_policy TO oxagen_app;
  END IF;
END;
$$;

COMMIT;
