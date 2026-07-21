-- workspace-graph boundary — Postgres canonical-truth projection + immutable
-- run-evidence ledger (docs/specs/workspace-graph-boundary/spec.md).
--
-- Two groups of tables, in TWO EXISTING schemas (no CREATE SCHEMA — mirrors
-- 20260804100000_agent_runs_durable_schema.sql, "schema-level grants preexist"):
--
--   ingestion.*  — the governed workspace-graph CODE PROJECTION (canonical
--     truth that the RBAC-filtered Neo4j workspace projection is rebuilt from):
--     code_repositories, repository_snapshots, repository_ref_observations,
--     projection_generations, code_scopes. Sits beside source_connections /
--     github_installations (its upstream).
--
--   agent.*  — the immutable EVIDENCE BRIDGE (RunEvidenceManifestV1): every
--     governed agent attempt's exact commit/file/context/verification facts,
--     retained even when work never merges. run_evidence_manifests,
--     run_evidence_changes, run_context_frames. Sits beside agent_runs.
--
-- Design notes:
--   - No `atlas migrate diff` (broken by the pg_trgm fresh-replay defect,
--     docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md) — every
--     migration since is hand-written + `atlas migrate hash`, same as the
--     agent_runs migration.
--   - Within-schema parent→child links are real FKs; cross-schema links
--     (code_repositories.source_connection_id → ingestion.source_connections;
--     run_evidence_*.repository_id / checkout_repository_id / code_scope_id →
--     ingestion.code_*) are app-enforced (no .references()), per CLAUDE.md
--     storage rules.
--   - Every table carries org_id + workspace_id and the tenant_isolation RLS
--     policy (same shape as 20260804100000 / 20260612140000). Snapshots are not
--     workspace-private, but the shared RLS policy keys on those columns, so a
--     child table carries them exactly like agent_run_events.
--   - The evidence tables are APPEND-ONLY (created_at only, no updated_at, no
--     soft delete); the projection tables that mutate during a build
--     (code_repositories, projection_generations) carry updated_at.
--   - run_evidence_manifests idempotency uses UNIQUE NULLS NOT DISTINCT so a
--     null attempt_id still dedupes on (org_id, run_id, manifest_digest).

-- ════════════════════════════════════════════════════════════════════════════
-- ingestion.* — code projection
-- ════════════════════════════════════════════════════════════════════════════

-- ── ingestion.code_repositories ───────────────────────────────────────────────
CREATE TABLE "ingestion"."code_repositories" (
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
  "provider" text NOT NULL,
  "provider_repo_id" text NOT NULL,
  "owner" text NOT NULL,
  "name" text NOT NULL,
  "installation_id" text NULL,
  -- Cross-schema logical FK → ingestion.source_connections (app-enforced).
  "source_connection_id" uuid NULL,
  "default_ref" text NOT NULL,
  "observed_head_sha" text NULL,
  "projected_head_sha" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "code_repositories_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "code_repositories_org_provider_repo_uq"
    UNIQUE ("org_id", "provider", "provider_repo_id"),
  CONSTRAINT "code_repositories_provider_check"
    CHECK (provider IN ('github'))
);
CREATE INDEX "code_repositories_workspace_org_idx"
  ON "ingestion"."code_repositories" ("workspace_id", "org_id");
CREATE INDEX "code_repositories_source_connection_idx"
  ON "ingestion"."code_repositories" ("source_connection_id");

-- ── ingestion.repository_snapshots ─────────────────────────────────────────────
CREATE TABLE "ingestion"."repository_snapshots" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "commit_sha" text NOT NULL,
  "tree_sha" text NOT NULL,
  "parent_shas" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  "source" text NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "repository_snapshots_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "repository_snapshots_repo_commit_uq"
    UNIQUE ("repository_id", "commit_sha"),
  CONSTRAINT "repository_snapshots_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "ingestion"."code_repositories" ("id"),
  CONSTRAINT "repository_snapshots_source_check"
    CHECK (source IN ('provider_observed', 'runner_observed'))
);
CREATE INDEX "repository_snapshots_repository_idx"
  ON "ingestion"."repository_snapshots" ("repository_id");

-- ── ingestion.repository_ref_observations ──────────────────────────────────────
CREATE TABLE "ingestion"."repository_ref_observations" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "ref" text NOT NULL,
  "before_sha" text NULL,
  "after_sha" text NULL,
  "forced" boolean NOT NULL DEFAULT false,
  "deleted" boolean NOT NULL DEFAULT false,
  "delivery_id" text NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "repository_ref_observations_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "repository_ref_observations_delivery_id_uq" UNIQUE ("delivery_id"),
  CONSTRAINT "repository_ref_observations_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "ingestion"."code_repositories" ("id")
);
CREATE INDEX "repository_ref_observations_repository_idx"
  ON "ingestion"."repository_ref_observations" ("repository_id");

-- ── ingestion.projection_generations ───────────────────────────────────────────
CREATE TABLE "ingestion"."projection_generations" (
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
  "repository_id" uuid NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'building',
  "files_total" integer NOT NULL DEFAULT 0,
  "files_processed" integer NOT NULL DEFAULT 0,
  "files_skipped" integer NOT NULL DEFAULT 0,
  "truncated" boolean NOT NULL DEFAULT false,
  "parser_version" text NULL,
  "error" jsonb NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz NULL,
  "activated_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "projection_generations_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "projection_generations_repo_snapshot_uq"
    UNIQUE ("repository_id", "snapshot_id"),
  CONSTRAINT "projection_generations_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "ingestion"."code_repositories" ("id"),
  CONSTRAINT "projection_generations_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "ingestion"."repository_snapshots" ("id"),
  CONSTRAINT "projection_generations_status_check"
    CHECK (status IN ('building', 'active', 'failed', 'superseded'))
);
-- At most one 'active' generation per repository (the served projection).
CREATE UNIQUE INDEX "projection_generations_one_active_per_repo_uq"
  ON "ingestion"."projection_generations" ("repository_id")
  WHERE status = 'active';
CREATE INDEX "projection_generations_repository_idx"
  ON "ingestion"."projection_generations" ("repository_id");

-- ── ingestion.code_scopes ──────────────────────────────────────────────────────
CREATE TABLE "ingestion"."code_scopes" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "generation_id" uuid NOT NULL,
  "scope_key" text NOT NULL,
  "kind" text NOT NULL,
  "display_name" text NOT NULL,
  "domain_slug" text NULL,
  "file_count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "code_scopes_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "code_scopes_generation_scope_uq"
    UNIQUE ("generation_id", "scope_key"),
  CONSTRAINT "code_scopes_repository_id_fkey"
    FOREIGN KEY ("repository_id") REFERENCES "ingestion"."code_repositories" ("id"),
  CONSTRAINT "code_scopes_generation_id_fkey"
    FOREIGN KEY ("generation_id") REFERENCES "ingestion"."projection_generations" ("id"),
  CONSTRAINT "code_scopes_kind_check"
    CHECK (kind IN ('package', 'service', 'module', 'path'))
);
CREATE INDEX "code_scopes_repository_idx"
  ON "ingestion"."code_scopes" ("repository_id");
CREATE INDEX "code_scopes_generation_idx"
  ON "ingestion"."code_scopes" ("generation_id");

-- ════════════════════════════════════════════════════════════════════════════
-- agent.* — immutable evidence bridge
-- ════════════════════════════════════════════════════════════════════════════

-- ── agent.run_evidence_manifests ───────────────────────────────────────────────
CREATE TABLE "agent"."run_evidence_manifests" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id" text NOT NULL,
  "attempt_id" text NULL,
  "initiating_principal_id" text NOT NULL,
  "agent_principal_id" text NULL,
  "agent_version_id" text NULL,
  "authorization_snapshot_id" text NULL,
  -- Cross-schema logical FK → ingestion.code_repositories (app-enforced).
  "checkout_repository_id" uuid NULL,
  "base_commit_sha" text NULL,
  "head_commit_sha" text NULL,
  "head_tree_sha" text NULL,
  "dirty_patch_digest" text NULL,
  "untracked_manifest_digest" text NULL,
  "graph_generation_id" text NULL,
  "graph_schema_version" text NULL,
  "extractor_version" text NULL,
  "indexed_root_digest" text NULL,
  "checkout_completed_at" timestamptz NULL,
  "freshness_status" text NULL,
  "evidence_authority" text NOT NULL DEFAULT 'client_attested',
  "manifest_digest" text NOT NULL,
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "run_evidence_manifests_public_id_unique" UNIQUE ("public_id"),
  -- Idempotent resubmission. NULLS NOT DISTINCT so a null attempt_id still
  -- dedupes on (org_id, run_id, manifest_digest).
  CONSTRAINT "run_evidence_manifests_idempotency_uq"
    UNIQUE NULLS NOT DISTINCT ("org_id", "run_id", "attempt_id", "manifest_digest"),
  CONSTRAINT "run_evidence_manifests_authority_check"
    CHECK (evidence_authority IN ('runner_observed', 'provider_observed', 'client_attested', 'inferred'))
);
CREATE INDEX "run_evidence_manifests_org_run_idx"
  ON "agent"."run_evidence_manifests" ("org_id", "run_id");
CREATE INDEX "run_evidence_manifests_workspace_org_idx"
  ON "agent"."run_evidence_manifests" ("workspace_id", "org_id");
CREATE INDEX "run_evidence_manifests_checkout_repository_idx"
  ON "agent"."run_evidence_manifests" ("checkout_repository_id");

-- ── agent.run_evidence_changes ─────────────────────────────────────────────────
CREATE TABLE "agent"."run_evidence_changes" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "manifest_id" uuid NOT NULL,
  -- Cross-schema logical FK → ingestion.code_repositories (app-enforced).
  "repository_id" uuid NULL,
  "path_locator" text NOT NULL,
  "change_kind" text NOT NULL,
  "before_digest" text NULL,
  "after_digest" text NULL,
  -- Cross-schema logical FK → ingestion.code_scopes (app-enforced).
  "code_scope_id" uuid NULL,
  "domain_slug" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "run_evidence_changes_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "run_evidence_changes_manifest_id_fkey"
    FOREIGN KEY ("manifest_id") REFERENCES "agent"."run_evidence_manifests" ("id"),
  CONSTRAINT "run_evidence_changes_change_kind_check"
    CHECK (change_kind IN ('added', 'modified', 'deleted', 'renamed'))
);
CREATE INDEX "run_evidence_changes_manifest_idx"
  ON "agent"."run_evidence_changes" ("manifest_id");
CREATE INDEX "run_evidence_changes_repository_path_idx"
  ON "agent"."run_evidence_changes" ("repository_id", "path_locator");

-- ── agent.run_context_frames ───────────────────────────────────────────────────
CREATE TABLE "agent"."run_context_frames" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "manifest_id" uuid NOT NULL,
  "provider_id" text NOT NULL,
  "frame_id" text NOT NULL,
  "uri" text NULL,
  "canonical_content_digest" text NOT NULL,
  "local_graph_generation_id" text NULL,
  "authorization_decision_id" text NULL,
  "retention_mode" text NOT NULL,
  "token_cost" integer NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "run_context_frames_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "run_context_frames_manifest_id_fkey"
    FOREIGN KEY ("manifest_id") REFERENCES "agent"."run_evidence_manifests" ("id"),
  CONSTRAINT "run_context_frames_retention_mode_check"
    CHECK (retention_mode IN ('hash_only', 'content_retained'))
);
CREATE INDEX "run_context_frames_manifest_idx"
  ON "agent"."run_context_frames" ("manifest_id");

-- ════════════════════════════════════════════════════════════════════════════
-- RLS — tenant_isolation (same shape as 20260804100000 / 20260612140000)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE ingestion.code_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.code_repositories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.code_repositories;
CREATE POLICY tenant_isolation ON ingestion.code_repositories
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE ingestion.repository_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.repository_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.repository_snapshots;
CREATE POLICY tenant_isolation ON ingestion.repository_snapshots
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE ingestion.repository_ref_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.repository_ref_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.repository_ref_observations;
CREATE POLICY tenant_isolation ON ingestion.repository_ref_observations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE ingestion.projection_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.projection_generations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.projection_generations;
CREATE POLICY tenant_isolation ON ingestion.projection_generations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE ingestion.code_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.code_scopes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.code_scopes;
CREATE POLICY tenant_isolation ON ingestion.code_scopes
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.run_evidence_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.run_evidence_manifests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.run_evidence_manifests;
CREATE POLICY tenant_isolation ON agent.run_evidence_manifests
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.run_evidence_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.run_evidence_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.run_evidence_changes;
CREATE POLICY tenant_isolation ON agent.run_evidence_changes
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.run_context_frames ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.run_context_frames FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.run_context_frames;
CREATE POLICY tenant_isolation ON agent.run_context_frames
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ════════════════════════════════════════════════════════════════════════════
-- oxagen_app grants (guarded — fresh clusters may lack the role). Schema-level
-- USAGE on ingestion/agent preexists.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion.code_repositories TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion.repository_snapshots TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion.repository_ref_observations TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion.projection_generations TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion.code_scopes TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.run_evidence_manifests TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.run_evidence_changes TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.run_context_frames TO oxagen_app';
  END IF;
END
$$;
