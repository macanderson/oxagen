-- 0028_documents_forms_automations_prefs.sql
--
-- Program 0 — make the contract-declared stub capabilities real. Creates the
-- backing tables for document.*, form.*, and automation.* (previously stubs
-- returning fake data), and adds the agent.skills.enabled column that
-- skill.workspace.list needs.
--
-- Tables declared in packages/database/src/schema/{content,workflow}.ts. RLS
-- policies use the standard bypass-aware tenant_isolation form (mirrors 0016);
-- POLICY_MANIFEST entries added in the same change (tenant-policy.manifest.ts).
-- Mirrors the id/audit/org-scope mixin column style of 0014_workflow_runs.sql.
--
-- Forward migration — immutable after merge (OXA-1515 policy).
BEGIN;

-- Ensure the target schemas exist (idempotent). The baseline creates them on a
-- fresh DB; this guard makes the migration self-sufficient on any DB state.
CREATE SCHEMA IF NOT EXISTS content;
CREATE SCHEMA IF NOT EXISTS workflow;

-- ── content.documents ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content.documents (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  title              text        NOT NULL,
  content            text        NOT NULL DEFAULT '',
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS documents_org_idx ON content.documents (org_id, workspace_id);

-- ── content.forms ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content.forms (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  title              text        NOT NULL,
  fields             jsonb       NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS forms_org_idx ON content.forms (org_id, workspace_id);

-- ── content.form_submissions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content.form_submissions (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  form_id            uuid        NOT NULL,
  responses          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status             citext      NOT NULL DEFAULT 'submitted',
  CONSTRAINT form_submissions_status_check
    CHECK (status IN ('submitted', 'reviewed', 'archived'))
);
CREATE INDEX IF NOT EXISTS form_submissions_form_idx ON content.form_submissions (form_id);
CREATE INDEX IF NOT EXISTS form_submissions_org_idx ON content.form_submissions (org_id, workspace_id);

-- ── workflow.automations ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow.automations (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  name               text        NOT NULL,
  status             citext      NOT NULL DEFAULT 'active',
  trigger_config     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  action_config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT automations_status_check
    CHECK (status IN ('active', 'paused', 'archived'))
);
CREATE INDEX IF NOT EXISTS automations_org_idx ON workflow.automations (org_id, workspace_id);

-- ── workflow.automation_runs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow.automation_runs (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  automation_id      uuid        NOT NULL,
  status             citext      NOT NULL DEFAULT 'running',
  payload            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT automation_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS automation_runs_automation_idx ON workflow.automation_runs (automation_id);
CREATE INDEX IF NOT EXISTS automation_runs_org_status_idx ON workflow.automation_runs (org_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS automation_runs_org_idx ON workflow.automation_runs (org_id, workspace_id);

-- ── Row-level security: standard bypass-aware tenant isolation (mirrors 0016) ──
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content.documents', 'content.forms', 'content.form_submissions',
    'workflow.automations', 'workflow.automation_runs'
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON content.documents        TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON content.forms            TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON content.form_submissions TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON workflow.automations     TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON workflow.automation_runs TO oxagen_app;
  END IF;
END;
$$;

-- ── agent.skills: per-workspace enable toggle for skill.workspace.list ─────────
ALTER TABLE agent.skills
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

COMMIT;
