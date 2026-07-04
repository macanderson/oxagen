-- ai.response_cache + ai.batch_jobs — AI-efficiency control plane.
--
-- Purpose:
--   response_cache — layered (exact + semantic) response cache for OPT-IN
--     deterministic background LLM calls (title generation, classification,
--     enrichment). Never engaged for chat/agent-loop calls. Cache-hit savings
--     are emitted to ClickHouse through the existing metering path so the
--     observed-usage → billing loop can price them.
--   batch_jobs — durable tracking record for Anthropic Message Batches
--     submissions (async background inference at half price).
--
-- Notes:
--   - New `ai` schema; CREATE SCHEMA + oxagen_app USAGE grant included.
--   - No cross-schema FK .references(); app-enforced FKs per CLAUDE.md.
--   - RLS follows the tenant_isolation pattern from 20260612140000 exactly.
--   - Semantic layer stores the prompt embedding as jsonb (number[]) and scans
--     a bounded recent window in-app — pgvector is not installed. Swapping in a
--     pgvector ANN index later is a storage-only migration, no caller change.

-- ── ai schema ─────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS "ai";

-- ── ai.response_cache ─────────────────────────────────────────────────────────
CREATE TABLE "ai"."response_cache" (
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
  -- Exact-match key: sha256 hex of prompt_hash + model + surface + call-shape.
  "cache_key" text NOT NULL,
  -- SHA-256 of the rendered prompt (mirrors token_usage.prompt_hash).
  "prompt_hash" text NOT NULL,
  -- Resolved model id (gateway slug).
  "model" text NOT NULL,
  -- Origin surface.
  "surface" text NOT NULL,
  -- Cached payload shape.
  "response_kind" text NOT NULL DEFAULT 'object',
  -- Cached result payload.
  "response" jsonb NOT NULL,
  -- Usage snapshot from the original miss (drives the savings figure on hit).
  "usage" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Prompt embedding for the semantic layer (number[] as jsonb). NULL = exact only.
  "embedding" jsonb NULL,
  -- Hit tally + last-hit wall-clock.
  "hit_count" integer NOT NULL DEFAULT 0,
  "last_hit_at" timestamptz NULL,
  -- Hard expiry: created_at + ttlSeconds.
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "response_cache_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "ai_response_cache_response_kind_check"
    CHECK (response_kind IN ('object', 'text'))
);

-- At most one live entry per (workspace, cache_key).
CREATE UNIQUE INDEX "ai_response_cache_key_uniq"
  ON "ai"."response_cache" ("org_id", "workspace_id", "cache_key")
  WHERE (deleted_at IS NULL);

-- Semantic candidate scan.
CREATE INDEX "ai_response_cache_candidate_idx"
  ON "ai"."response_cache" ("org_id", "workspace_id", "model", "surface");

-- Expiry sweeper.
CREATE INDEX "ai_response_cache_expires_idx"
  ON "ai"."response_cache" ("expires_at");

-- ── ai.batch_jobs ─────────────────────────────────────────────────────────────
CREATE TABLE "ai"."batch_jobs" (
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
  "provider" text NOT NULL DEFAULT 'anthropic',
  -- Provider-issued batch id (`msgbatch_…`). NULL only pre-submit.
  "provider_batch_id" text NULL,
  "surface" text NOT NULL,
  -- Bare Anthropic model id (batches bypass the gateway).
  "model" text NOT NULL,
  "status" text NOT NULL DEFAULT 'submitted',
  "request_count" integer NOT NULL DEFAULT 0,
  "succeeded_count" integer NOT NULL DEFAULT 0,
  "errored_count" integer NOT NULL DEFAULT 0,
  "expired_count" integer NOT NULL DEFAULT 0,
  "canceled_count" integer NOT NULL DEFAULT 0,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "submitted_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "batch_jobs_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "ai_batch_jobs_status_check"
    CHECK (status IN ('submitted', 'in_progress', 'ended', 'canceled', 'expired', 'failed'))
);

CREATE INDEX "ai_batch_jobs_org_idx"
  ON "ai"."batch_jobs" ("org_id", "workspace_id");

CREATE INDEX "ai_batch_jobs_status_idx"
  ON "ai"."batch_jobs" ("org_id", "workspace_id", "status");

CREATE UNIQUE INDEX "ai_batch_jobs_provider_batch_uniq"
  ON "ai"."batch_jobs" ("provider_batch_id")
  WHERE (provider_batch_id IS NOT NULL AND deleted_at IS NULL);

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.
ALTER TABLE ai.response_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.response_cache FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai.response_cache;
CREATE POLICY tenant_isolation ON ai.response_cache
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE ai.batch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.batch_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai.batch_jobs;
CREATE POLICY tenant_isolation ON ai.batch_jobs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
-- New schema: grant USAGE + table DML so RLS-scoped app queries work immediately.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ai TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ai.response_cache TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ai.batch_jobs TO oxagen_app';
  END IF;
END
$$;
