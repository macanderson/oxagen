-- agent.sandbox_sessions — durable code-agent sandbox session registry.
--
-- Purpose: tracks long-lived Modal (and future-driver) sandboxes across agent
-- turns. One row per sandbox; sessions are reused via session_key (a caller-
-- supplied stable key such as a conversation or agent-run id). snapshotId
-- enables warm filesystem restore after idle eviction. Status lifecycle:
--   running → idle (TTL timer fires) → stopped (explicit) → gone (GC'd/evicted)
--
-- Notes:
--   - The agent schema already exists; no CREATE SCHEMA needed.
--   - No cross-schema FK .references(); app-enforced FKs per CLAUDE.md.
--   - Partial unique index enforces at most one live durable session per
--     (workspace, session_key): WHERE (session_key IS NOT NULL AND
--     status IN ('running','idle') AND deleted_at IS NULL).
--   - RLS follows the tenant_isolation pattern from 20260612140000.
--   - oxagen_app grants target only the new table (agent schema-level grants
--     were applied in an earlier migration; this is additive, idempotent).

-- ── agent.sandbox_sessions ────────────────────────────────────────────────────
CREATE TABLE "agent"."sandbox_sessions" (
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
  -- Caller-supplied stable key (conversation id / agent-run id) enabling
  -- sandbox reuse across turns. NULL for ephemeral (no-reuse) sandboxes.
  "session_key" text NULL,
  -- Sandbox driver, e.g. "modal".
  "driver" text NOT NULL,
  -- Runtime image: node | python | shell | agent.
  "image" text NOT NULL,
  -- Driver-issued live sandbox id (Modal `sb-...`). Updated on restore.
  "sandbox_id" text NOT NULL,
  -- Last filesystem snapshot id for warm restore; NULL before first snapshot.
  "snapshot_id" text NULL,
  -- Lifecycle status. Defaults to 'running' on insert.
  "status" text NOT NULL DEFAULT 'running',
  -- Wall-clock of most recent agent interaction (drives TTL logic).
  "last_used_at" timestamptz NULL,
  -- Soft expiry: created_at + configured TTL. NULL = no expiry.
  "expires_at" timestamptz NULL,
  -- Arbitrary driver / caller metadata (image labels, resource class, etc.).
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("id"),
  CONSTRAINT "sandbox_sessions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "sandbox_sessions_status_check"
    CHECK (status IN ('running', 'idle', 'stopped', 'gone')),
  CONSTRAINT "sandbox_sessions_image_check"
    CHECK (image IN ('node', 'python', 'shell', 'agent'))
);

-- Broad org/workspace scan (list, expiry sweeper).
CREATE INDEX "sandbox_sessions_org_idx"
  ON "agent"."sandbox_sessions" ("org_id", "workspace_id");

-- Status-filtered list (active sessions per workspace).
CREATE INDEX "sandbox_sessions_status_idx"
  ON "agent"."sandbox_sessions" ("org_id", "workspace_id", "status");

-- At most one live durable sandbox per (workspace, session_key).
CREATE UNIQUE INDEX "sandbox_sessions_session_key_uniq"
  ON "agent"."sandbox_sessions" ("workspace_id", "session_key")
  WHERE (session_key IS NOT NULL AND status IN ('running', 'idle') AND deleted_at IS NULL);

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.
ALTER TABLE agent.sandbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.sandbox_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.sandbox_sessions;
CREATE POLICY tenant_isolation ON agent.sandbox_sessions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
-- Agent schema-level grants exist from earlier migrations. Grant on the new
-- table specifically so RLS-bypassing service-role queries work immediately.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.sandbox_sessions TO oxagen_app';
  END IF;
END
$$;
