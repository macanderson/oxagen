-- agent.a2a_tasks — durable state for the A2A (Agent2Agent) protocol transport.
--
-- Purpose: persists one row per A2A task created via the A2A JSON-RPC surface
-- (POST /a2a, alongside /mcp). The external public_id (a2a_...) is the opaque
-- taskId A2A clients receive; the caller-supplied A2A contextId groups tasks in
-- one multi-turn conversation. State lifecycle uses the A2A lowercase wire
-- strings; the CHECK mirrors A2A_TASK_STATES:
--   submitted → working → (input-required | auth-required) → completed
--   working → (failed | rejected | canceled)   [terminal]
--
-- Notes:
--   - The agent schema already exists; no CREATE SCHEMA needed.
--   - No cross-schema FK .references(); app-enforced FKs per CLAUDE.md.
--   - message_history / artifacts hold the exact A2A wire JSON so tasks/get can
--     round-trip them without translation.
--   - RLS follows the tenant_isolation pattern from 20260612140000.
--   - oxagen_app grant is additive + idempotent (schema-level grants preexist).

-- ── agent.a2a_tasks ───────────────────────────────────────────────────────────
CREATE TABLE "agent"."a2a_tasks" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  -- A2A conversation-grouping id (opaque; caller-supplied or server-minted).
  "context_id" text NOT NULL,
  -- A2A task lifecycle state (lowercase wire string). DEFAULT 'submitted'.
  "state" text NOT NULL DEFAULT 'submitted',
  -- The A2A Message[] history (user turn + agent reply) as wire JSON.
  "message_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The A2A Artifact[] produced by the agent as wire JSON.
  "artifacts" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The current TaskStatus.message (agent-facing status text), if any.
  "status_message" jsonb NULL,
  -- Terminal error detail for failed/rejected tasks (null otherwise).
  "error_message" text NULL,
  -- Arbitrary caller/agent metadata carried on the task.
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("id"),
  CONSTRAINT "a2a_tasks_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "a2a_tasks_state_check"
    CHECK (state IN ('submitted', 'working', 'input-required', 'auth-required', 'completed', 'canceled', 'failed', 'rejected', 'unknown'))
);

-- Broad org/workspace scan (list, GC sweeper).
CREATE INDEX "a2a_tasks_org_idx"
  ON "agent"."a2a_tasks" ("org_id", "workspace_id");

-- Conversation grouping lookup (tasks sharing a contextId).
CREATE INDEX "a2a_tasks_context_idx"
  ON "agent"."a2a_tasks" ("workspace_id", "context_id");

-- State-filtered list (active tasks per workspace).
CREATE INDEX "a2a_tasks_state_idx"
  ON "agent"."a2a_tasks" ("org_id", "workspace_id", "state");

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.
ALTER TABLE agent.a2a_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.a2a_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.a2a_tasks;
CREATE POLICY tenant_isolation ON agent.a2a_tasks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.a2a_tasks TO oxagen_app';
  END IF;
END
$$;
