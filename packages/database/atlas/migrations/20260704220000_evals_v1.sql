-- Evals v1 — datasets + LLM-as-judge runs (tenant-scoped Postgres state).
--
-- Wedge alignment (docs/VISION.md): not a standalone eval platform — these
-- tables score what actually ran and got billed. Datasets can be seeded from
-- the already-metered run traces; per-item RESULTS live in ClickHouse
-- (eval_item_results), only the durable definitions + run summaries live here.
--
-- Notes:
--   - No cross-schema FK .references(); app-enforced FKs (matches the codebase).
--   - Partial unique index (WHERE deleted_at IS NULL) is canonical here.
--   - RLS follows the tenant_isolation pattern from 20260612140000 exactly.
--   - oxagen_app grants mirror the environments block (20260626120000).

-- ── Schema ────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS "eval";

-- ── eval.eval_datasets ────────────────────────────────────────────────────────
CREATE TABLE "eval"."eval_datasets" (
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
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "description" text NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "item_count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "eval_datasets_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "eval_datasets_source_check" CHECK (source IN ('manual', 'traces'))
);
CREATE INDEX "eval_datasets_org_idx"
  ON "eval"."eval_datasets" ("org_id", "workspace_id");
CREATE UNIQUE INDEX "eval_datasets_workspace_slug_uniq"
  ON "eval"."eval_datasets" ("workspace_id", "slug")
  WHERE (deleted_at IS NULL);

-- ── eval.eval_dataset_items ───────────────────────────────────────────────────
CREATE TABLE "eval"."eval_dataset_items" (
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
  "dataset_id" uuid NOT NULL,
  "input" text NOT NULL,
  "expected_output" text NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("id"),
  CONSTRAINT "eval_dataset_items_public_id_unique" UNIQUE ("public_id")
);
CREATE INDEX "eval_dataset_items_dataset_idx"
  ON "eval"."eval_dataset_items" ("dataset_id");
CREATE INDEX "eval_dataset_items_org_idx"
  ON "eval"."eval_dataset_items" ("org_id", "workspace_id");

-- ── eval.eval_runs ────────────────────────────────────────────────────────────
CREATE TABLE "eval"."eval_runs" (
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
  "dataset_id" uuid NOT NULL,
  "name" text NULL,
  "target" jsonb NOT NULL,
  "judge_model" text NOT NULL,
  "pass_threshold" numeric NOT NULL DEFAULT 0.7,
  "status" public.citext NOT NULL DEFAULT 'pending',
  "item_count" integer NOT NULL DEFAULT 0,
  "completed_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "avg_score" numeric NULL,
  "score_breakdown" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "inngest_event_id" text NULL,
  "started_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  "failed_at" timestamptz NULL,
  "failure_reason" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "eval_runs_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "eval_runs_status_check"
    CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX "eval_runs_dataset_idx"
  ON "eval"."eval_runs" ("dataset_id");
CREATE INDEX "eval_runs_org_idx"
  ON "eval"."eval_runs" ("org_id", "workspace_id");

-- ── RLS — tenant_isolation on all three eval tables ───────────────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.

ALTER TABLE eval.eval_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval.eval_datasets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON eval.eval_datasets;
CREATE POLICY tenant_isolation ON eval.eval_datasets
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE eval.eval_dataset_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval.eval_dataset_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON eval.eval_dataset_items;
CREATE POLICY tenant_isolation ON eval.eval_dataset_items
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE eval.eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval.eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON eval.eval_runs;
CREATE POLICY tenant_isolation ON eval.eval_runs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants for eval ────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA eval TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA eval TO oxagen_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA eval TO oxagen_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA eval GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA eval GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app';
  END IF;
END
$$;
