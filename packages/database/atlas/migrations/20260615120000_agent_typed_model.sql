-- Additive schema for the typed agent model (docs/reference/agent-schema.ts).
-- All statements are additive — no existing column is dropped or altered.
--
--   1. agents.deployment_status — deploy on/off toggle, distinct from the
--      draft/active/archived authoring lifecycle in agents.status.
--   2. agent_triggers — how a deployed agent is invoked (manual/schedule/event).
--   3. agent_executions — parent_execution_id (subagent/A2A lineage), debug
--      (per-run DebugOptions), state (live AgentInstance thread state).
--
-- Idempotent: every statement uses IF NOT EXISTS / IF EXISTS so it is safe to
-- replay on a clean database. Atlas tracks idempotency via atlas.sum — do NOT
-- edit this file after it is applied.

-- 1. agents.deployment_status
ALTER TABLE "agent"."agents"
  ADD COLUMN IF NOT EXISTS "deployment_status" text NOT NULL DEFAULT 'inactive';
ALTER TABLE "agent"."agents" DROP CONSTRAINT IF EXISTS "agents_deployment_status_check";
ALTER TABLE "agent"."agents" ADD CONSTRAINT "agents_deployment_status_check"
  CHECK ("deployment_status" IN ('inactive', 'active'));
CREATE INDEX IF NOT EXISTS "agents_deployment_status_idx"
  ON "agent"."agents" ("org_id", "workspace_id", "deployment_status");

-- 2. agent_triggers
CREATE TABLE IF NOT EXISTS "agent"."agent_triggers" (
  "id" uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  "public_id" citext NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "agent_id" uuid NOT NULL REFERENCES "agent"."agents" ("id"),
  "trigger_type" text NOT NULL,
  "event_source" text,
  "event_type" text,
  "connection_id" uuid,
  "filter" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "schedule" text,
  "enabled" boolean NOT NULL DEFAULT false,
  CONSTRAINT "agent_triggers_trigger_type_check"
    CHECK ("trigger_type" IN ('manual', 'schedule', 'event'))
);
CREATE INDEX IF NOT EXISTS "agent_triggers_agent_idx"
  ON "agent"."agent_triggers" ("agent_id");
CREATE INDEX IF NOT EXISTS "agent_triggers_org_idx"
  ON "agent"."agent_triggers" ("org_id", "workspace_id");
CREATE INDEX IF NOT EXISTS "agent_triggers_type_enabled_idx"
  ON "agent"."agent_triggers" ("trigger_type", "enabled");

-- 3. agent_executions: AgentInstance shape (agent-schema.ts §4)
ALTER TABLE "agent"."agent_executions"
  ADD COLUMN IF NOT EXISTS "parent_execution_id" uuid,
  ADD COLUMN IF NOT EXISTS "debug" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "state" jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS "agent_executions_parent_execution_idx"
  ON "agent"."agent_executions" ("parent_execution_id");

-- 4. Tenant RLS for agent_triggers (POLICY_MANIFEST: standard class). Matches
--    tools/scripts/gen-rls-migration.ts output so the new org-scoped table is
--    covered by integration/manifest-coverage.test.ts. oxagen_app picks up
--    table privileges via the ALTER DEFAULT PRIVILEGES set in
--    20260612052000_regrant_oxagen_app.sql.
ALTER TABLE agent.agent_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_triggers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_triggers;
CREATE POLICY tenant_isolation ON agent.agent_triggers
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
