-- agent.file_locks + agent.file_lock_fences — the transactional file-lock
-- authority (ADR-021 §5).
--
-- Purpose: move file-lock authority OFF Neo4j and INTO Postgres. The graph sync
-- path is asynchronous (ADR-018), so a lock "written to the graph" is invisible
-- to a concurrent agent for the duration of sync lag — fatal for mutual
-- exclusion. These rows are the source of truth; Neo4j only carries an async
-- LINEAGE projection (packages/inngest-functions/agent.project-file-lock-to-graph).
--
-- Design:
--   - file_locks: one LIVE lock per (workspace_id, resource_key), enforced by a
--     partial unique index WHERE released_at IS NULL. resource_key is a
--     repo-relative path (local CLI) or the SourceFile naturalKey (platform).
--     lease_expires_at gives TTL expiry; an expired-but-unreleased row is
--     treated as free (takeover) by the acquire path and reaped by the sweeper.
--   - file_lock_fences: a durable, monotonic fencing-token counter per resource,
--     bumped only on a successful acquire. It lives in its OWN table (not
--     derived from file_locks) so the counter survives release: the next
--     acquirer of a resource always receives a strictly higher token than any
--     prior holder held, so a stale lease-holder's late write fails the
--     write-time fencing check.
--
-- Notes:
--   - The agent schema already exists; no CREATE SCHEMA needed.
--   - No cross-schema FK .references(); app-enforced FKs per CLAUDE.md.
--   - RLS follows the tenant_isolation pattern from 20260612140000.
--   - oxagen_app grant is additive + idempotent (schema-level grants preexist).

-- ── agent.file_locks ──────────────────────────────────────────────────────────
CREATE TABLE "agent"."file_locks" (
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
  -- Normalized resource identity (repo-relative path or SourceFile naturalKey).
  "resource_key" text NOT NULL,
  -- Lock-holder identity (agent/session/mission/fleet-task id). Same holder
  -- re-acquiring renews; a different holder conflicts.
  "holder" text NOT NULL,
  -- Correlates every lock a turn/execution holds, for batch release.
  "execution_id" text NOT NULL,
  -- Monotonic per (workspace_id, resource_key), sourced from file_lock_fences.
  "fencing_token" bigint NOT NULL,
  "action" text NOT NULL DEFAULT 'write',
  "lease_expires_at" timestamptz NOT NULL,
  -- Soft-release marker (NOT a soft delete): the partial unique index keys off
  -- it, so releasing frees the resource while keeping the row for a final
  -- projection.
  "released_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "file_locks_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "file_locks_action_check" CHECK (action IN ('read', 'write'))
);

-- The core invariant: at most ONE live lock per resource per workspace.
CREATE UNIQUE INDEX "file_locks_active_uniq"
  ON "agent"."file_locks" ("workspace_id", "resource_key")
  WHERE released_at IS NULL;

-- Broad org/workspace scan (list, sweeper).
CREATE INDEX "file_locks_org_idx"
  ON "agent"."file_locks" ("org_id", "workspace_id");

-- Batch release-by-execution (turn-end backstop).
CREATE INDEX "file_locks_execution_idx"
  ON "agent"."file_locks" ("org_id", "execution_id")
  WHERE released_at IS NULL;

-- ── agent.file_lock_fences ────────────────────────────────────────────────────
CREATE TABLE "agent"."file_lock_fences" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "resource_key" text NOT NULL,
  "current_token" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "file_lock_fences_resource_uniq" UNIQUE ("workspace_id", "resource_key")
);

CREATE INDEX "file_lock_fences_org_idx"
  ON "agent"."file_lock_fences" ("org_id", "workspace_id");

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.
ALTER TABLE agent.file_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.file_locks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.file_locks;
CREATE POLICY tenant_isolation ON agent.file_locks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.file_lock_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.file_lock_fences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.file_lock_fences;
CREATE POLICY tenant_isolation ON agent.file_lock_fences
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.file_locks TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.file_lock_fences TO oxagen_app';
  END IF;
END
$$;
