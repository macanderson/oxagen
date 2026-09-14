-- Run recorder and replay (#2952, ADR-057): frame bodies, the replay grade,
-- the archive segment, fork provenance, the generated summary, and the export
-- job. Expand-only: every column is nullable or defaulted, every CHECK admits
-- the rows that exist, and no privilege changes.
--
--   1. agent.agent_run_events gains the frame body (spec §8.2 `content`):
--      body_ref, body_digest, body_bytes, redactions, fidelity.
--   2. agent.agent_run_attempt_seals gains the seal's replay evidence
--      (spec §8.3, §8.4): replay_grade, completeness_gaps, merkle_root,
--      archive_segment_ref. Existing seals stay ungraded (NULL): nothing
--      graded them, and a grade is computed once at seal, never later.
--   3. agent.agent_runs and tacho.sessions gain the generated summary
--      (name, summary, summary_generated_at, summary_model; G14).
--   4. agent.agent_run_attempts gains forked_from_run_seq (fork_run).
--   5. tacho.sessions gains content_frames / body_frames, the counters the
--      tacho seal grades `body_missing` from.
--   6. evidence.run_exports: the export job export_run queues, with forced
--      tenant RLS in the manifest's shape (packages/database/src/
--      tenant-policy.manifest.ts) and the app role's grants.
--
-- The workspace's fidelity setting is the retention policy version a run pins
-- (evidence.retention_policy_versions.mode = 'digest_only'); no new setting
-- column exists (ADR-057 decision 2).

-- ── 1. Frame bodies on the event log ─────────────────────────────────────────
ALTER TABLE "agent"."agent_run_events"
  ADD COLUMN "body_ref" text NULL,
  ADD COLUMN "body_digest" text NULL,
  ADD COLUMN "body_bytes" integer NULL,
  ADD COLUMN "redactions" jsonb NULL,
  ADD COLUMN "fidelity" text NOT NULL DEFAULT 'digest_only';

ALTER TABLE "agent"."agent_run_events"
  ADD CONSTRAINT "agent_run_events_fidelity_check"
    CHECK ("fidelity" IN ('full', 'digest_only')),
  ADD CONSTRAINT "agent_run_events_body_shape_check" CHECK (
    (("fidelity" = 'full') = ("body_ref" IS NOT NULL))
    AND ("body_ref" IS NULL OR ("body_digest" IS NOT NULL AND "body_bytes" IS NOT NULL))
    AND ("body_digest" IS NOT NULL OR ("body_bytes" IS NULL AND "redactions" IS NULL))
    AND ("body_digest" IS NULL OR "body_digest" ~ '^sha256:[0-9a-f]{64}$')
    AND ("body_bytes" IS NULL OR "body_bytes" >= 0)
  );

-- ── 2. Replay evidence on the seal ───────────────────────────────────────────
ALTER TABLE "agent"."agent_run_attempt_seals"
  ADD COLUMN "replay_grade" text NULL,
  ADD COLUMN "completeness_gaps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "merkle_root" text NULL,
  ADD COLUMN "archive_segment_ref" text NULL;

ALTER TABLE "agent"."agent_run_attempt_seals"
  ADD CONSTRAINT "agent_run_attempt_seals_replay_grade_check"
    CHECK ("replay_grade" IS NULL OR "replay_grade" IN ('inspect', 'view', 'fork', 'retry')),
  ADD CONSTRAINT "agent_run_attempt_seals_replay_evidence_check" CHECK (
    (("replay_grade" IS NULL) = ("merkle_root" IS NULL))
    AND (("replay_grade" IS NULL) = ("archive_segment_ref" IS NULL))
    AND ("merkle_root" IS NULL OR "merkle_root" ~ '^sha256:[0-9a-f]{64}$')
    AND jsonb_typeof("completeness_gaps") = 'array'
  );

-- ── 3. Generated summary ─────────────────────────────────────────────────────
ALTER TABLE "agent"."agent_runs"
  ADD COLUMN "name" text NULL,
  ADD COLUMN "summary" text NULL,
  ADD COLUMN "summary_generated_at" timestamptz NULL,
  ADD COLUMN "summary_model" text NULL;

ALTER TABLE "agent"."agent_runs"
  ADD CONSTRAINT "agent_runs_summary_check" CHECK (
    (("summary" IS NULL) = ("summary_generated_at" IS NULL))
    AND (("summary" IS NULL) = ("summary_model" IS NULL))
  );

ALTER TABLE "tacho"."sessions"
  ADD COLUMN "name" text NULL,
  ADD COLUMN "summary" text NULL,
  ADD COLUMN "summary_generated_at" timestamptz NULL,
  ADD COLUMN "summary_model" text NULL;

ALTER TABLE "tacho"."sessions"
  ADD CONSTRAINT "tacho_sessions_summary_check" CHECK (
    (("summary" IS NULL) = ("summary_generated_at" IS NULL))
    AND (("summary" IS NULL) = ("summary_model" IS NULL))
  );

-- ── 4. Fork provenance ───────────────────────────────────────────────────────
ALTER TABLE "agent"."agent_run_attempts"
  ADD COLUMN "forked_from_run_seq" bigint NULL;

ALTER TABLE "agent"."agent_run_attempts"
  ADD CONSTRAINT "agent_run_attempts_fork_check" CHECK (
    "forked_from_run_seq" IS NULL
    OR ("forked_from_run_seq" >= 1 AND "resumed_from_attempt_id" IS NOT NULL)
  );

-- ── 5. Tacho body counters and the grade's CHECK ─────────────────────────────
ALTER TABLE "tacho"."sessions"
  ADD COLUMN "content_frames" integer NOT NULL DEFAULT 0,
  ADD COLUMN "body_frames" integer NOT NULL DEFAULT 0;

ALTER TABLE "tacho"."sessions"
  ADD CONSTRAINT "tacho_sessions_replay_grade_check"
    CHECK ("replay_grade" IS NULL OR "replay_grade" IN ('inspect', 'view', 'fork', 'retry')),
  ADD CONSTRAINT "tacho_sessions_body_frames_check"
    CHECK ("content_frames" >= 0 AND "body_frames" >= 0 AND "body_frames" <= "content_frames");

-- ── 6. evidence.run_exports ──────────────────────────────────────────────────
CREATE TABLE "evidence"."run_exports" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "run_public_id" text NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "bundle_ref" text NULL,
  "bundle_digest" text NULL,
  "merkle_root" text NULL,
  "frame_count" integer NULL,
  "completed_at" timestamptz NULL,
  "error" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "run_exports_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "run_exports_status_check"
    CHECK ("status" IN ('queued', 'building', 'ready', 'failed')),
  CONSTRAINT "run_exports_ready_check" CHECK (
    ("status" = 'ready') = (
      "bundle_ref" IS NOT NULL AND "bundle_digest" IS NOT NULL
      AND "merkle_root" IS NOT NULL AND "frame_count" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
  ),
  CONSTRAINT "run_exports_failed_check"
    CHECK (("status" = 'failed') = ("error" IS NOT NULL)),
  CONSTRAINT "run_exports_digest_check" CHECK (
    ("bundle_digest" IS NULL OR "bundle_digest" ~ '^sha256:[0-9a-f]{64}$')
    AND ("merkle_root" IS NULL OR "merkle_root" ~ '^sha256:[0-9a-f]{64}$')
    AND ("frame_count" IS NULL OR "frame_count" >= 0)
  )
);
CREATE INDEX "run_exports_org_idx"
  ON "evidence"."run_exports" ("org_id", "workspace_id", "created_at");
CREATE INDEX "run_exports_run_idx" ON "evidence"."run_exports" ("run_public_id");

-- Tenant isolation in the manifest's shape (tools/scripts/gen-rls-migration.ts,
-- policy class `standard`).
ALTER TABLE evidence.run_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.run_exports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON evidence.run_exports;
CREATE POLICY tenant_isolation ON evidence.run_exports
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- The job updates the row's status, so the app role keeps UPDATE; DELETE is
-- never granted, an export is a record.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON evidence.run_exports TO oxagen_app';
    EXECUTE 'REVOKE DELETE ON evidence.run_exports FROM oxagen_app';
  END IF;
END
$$;
