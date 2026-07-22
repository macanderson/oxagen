-- Fenced run/attempt foundation — EXPAND ONLY
-- (docs/specs/run-evidence-ingress/spec.md,
--  docs/specs/run-evidence-ingress/02-run-attempt-foundation-plan.md Task 2).
--
-- Purpose: give every governed run a trusted immutable admission record, every
-- worker claim a fenced attempt identity, every event an unambiguous order, and
-- every seal an atomically-minted finalization grant plus durable obligation.
--
-- EXPAND ONLY. This migration deliberately does NOT:
--   - apply the post-drain contract migration (that is PR 1B),
--   - revoke any privilege already-enqueued V1 work needs, or
--   - fabricate V2 columns for historical rows.
-- Every new column on agent_runs / agent_run_events is nullable at the column
-- level; completeness is enforced by CONDITIONAL CHECK constraints keyed on the
-- record-version discriminant, so preserved V1 history stays valid and readable
-- while queued V1 runs drain.
--
-- The V1/V2 discriminant, spelled out:
--   agent_runs.spec_version            1 = legacy RunSpecV1, 2 = trusted RunSpecV2
--   agent_run_events.event_record_version  1 = run-global legacy, 2 = fenced attempt
-- `agent_run_events_run_seq_uq` (a FULL unique on (run_id, seq)) is DROPPED and
-- replaced by three PARTIAL unique indexes. A leftover full constraint would
-- defeat the discriminant: every V2 row leaves `seq` NULL, and a partial index
-- is the only way to keep the legacy uniqueness promise for V1 rows while
-- enforcing the two V2 orderings independently.
--
-- Privilege posture (spec.md §"Four-store landing"): every evidence-bearing
-- table grants the application role SELECT + INSERT and NEVER UPDATE/DELETE.
-- Operational lease state is the single documented exception — it takes UPDATE
-- (renew/append/fence/seal all advance it) and still denies DELETE. A fenced
-- lease is evidence that an attempt lost its claim, not garbage to collect.
--
-- Hand-written (not `atlas migrate diff`): diff is broken by the unresolved
-- pg_trgm fresh-replay defect, the same reason every migration since
-- 20260703150000 is hand-written + `atlas migrate hash`.
--
-- Renumbered from the plan's 20260806100000: main advanced past that prefix
-- (20260806120000_spend_budgets.sql), and the plan mandates re-checking and
-- renumbering immediately before implementation.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. evidence schema — immutable governed-run evidence
-- ════════════════════════════════════════════════════════════════════════════
-- Isolated from `agent` on purpose: these rows are chain-of-custody records
-- with append-only grants and their own retention-administration path, so the
-- privilege boundary is a schema-level fact rather than a per-table convention.
CREATE SCHEMA IF NOT EXISTS "evidence";

-- ── evidence.retention_policy_versions ───────────────────────────────────────
-- Admission pins ONE exact (public_id, policy_digest) pair into the run row and
-- the serialized spec. A policy edit INSERTS a new version; it never rewrites an
-- admitted one, so a producer can never upgrade itself from digest-only to exact
-- retention after the fact.
CREATE TABLE "evidence"."retention_policy_versions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  -- Monotonically increasing per (org, workspace).
  "version" integer NOT NULL,
  "mode" text NOT NULL,
  "retained_content_classes" text[] NOT NULL DEFAULT '{}',
  "ttl_days" integer NOT NULL,
  "environment_restoration_rule" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- RFC 8785 canonical digest over the policy body.
  "policy_digest" text NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "retention_policy_versions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "retention_policy_versions_mode_check"
    CHECK (mode IN ('digest_only', 'content_exact', 'environment_restore')),
  CONSTRAINT "retention_policy_versions_version_check" CHECK (version > 0),
  CONSTRAINT "retention_policy_versions_ttl_check" CHECK (ttl_days > 0),
  CONSTRAINT "retention_policy_versions_digest_check"
    CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "retention_policy_versions_version_uniq"
  ON "evidence"."retention_policy_versions" ("org_id", "workspace_id", "version");
-- One canonical row per policy body per tenant — re-declaring the same policy
-- resolves to the existing version rather than forking the digest.
CREATE UNIQUE INDEX "retention_policy_versions_digest_uniq"
  ON "evidence"."retention_policy_versions" ("org_id", "workspace_id", "policy_digest");
CREATE INDEX "retention_policy_versions_org_idx"
  ON "evidence"."retention_policy_versions" ("org_id", "workspace_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 2. ingestion — governed repository bindings
-- ════════════════════════════════════════════════════════════════════════════
-- `source_connections.delivery_config` is a mutable JSONB bag: reading
-- repository identity from it means a rename or a reconfigured default ref
-- silently changes what an already-admitted run claims it saw. These three
-- tables replace that read with an immutable versioned binding plus two
-- explicit pointers.

CREATE TABLE "ingestion"."repository_bindings" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "connection_id" uuid NOT NULL,
  "provider" text NOT NULL,
  -- Immutable across renames (e.g. GitHub's numeric repository id) — the only
  -- field that survives a rename, which is why identity keys on it.
  "provider_repository_id" text NOT NULL,
  -- Provider observations at `observed_at`: annotations, never identity.
  "provider_owner" text NOT NULL,
  "provider_name" text NOT NULL,
  "provider_full_name" text NOT NULL,
  -- The EXACT configured default ref. Admission never falls back to "main".
  "configured_default_ref" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "version" integer NOT NULL,
  "supersedes_binding_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "repository_bindings_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "repository_bindings_version_check" CHECK (version > 0),
  -- Version 1 supersedes nothing; every later version names its parent, so the
  -- chain back to the first observation is never broken.
  CONSTRAINT "repository_bindings_supersedes_check"
    CHECK ((version = 1 AND supersedes_binding_id IS NULL)
        OR (version > 1 AND supersedes_binding_id IS NOT NULL)),
  CONSTRAINT "repository_bindings_supersedes_self_check"
    CHECK (supersedes_binding_id IS NULL OR supersedes_binding_id <> id),
  CONSTRAINT "repository_bindings_default_ref_check"
    CHECK (length(configured_default_ref) > 0)
);
CREATE UNIQUE INDEX "repository_bindings_repository_version_uq"
  ON "ingestion"."repository_bindings" ("connection_id", "provider_repository_id", "version");
CREATE INDEX "repository_bindings_org_idx"
  ON "ingestion"."repository_bindings" ("org_id", "workspace_id");
CREATE INDEX "repository_bindings_connection_idx"
  ON "ingestion"."repository_bindings" ("connection_id");

-- Mutable head pointer: which binding VERSION is current. Admission reads the
-- head to resolve, then copies the resolved identity into the immutable run
-- row, so advancing the head afterwards cannot rewrite an admitted run.
CREATE TABLE "ingestion"."repository_binding_heads" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_repository_id" text NOT NULL,
  "current_binding_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repository_binding_heads_repository_uq"
  ON "ingestion"."repository_binding_heads" ("connection_id", "provider_repository_id");
CREATE INDEX "repository_binding_heads_org_idx"
  ON "ingestion"."repository_binding_heads" ("org_id", "workspace_id");

-- Explicit primary-repository selection. Security admission follows THIS
-- pointer and never infers identity from delivery_config. A connection with
-- several repositories and no selection has no row, so admission FAILS CLOSED
-- rather than guessing which repository the agent may edit.
CREATE TABLE "ingestion"."governed_repository_selections" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "primary_binding_id" uuid NOT NULL,
  "selected_by_user_id" uuid NULL,
  "selected_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governed_repository_selections_connection_uq"
  ON "ingestion"."governed_repository_selections" ("connection_id");
CREATE INDEX "governed_repository_selections_org_idx"
  ON "ingestion"."governed_repository_selections" ("org_id", "workspace_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 3. agent.agent_runs — RunSpecV2 typed identity (expand)
-- ════════════════════════════════════════════════════════════════════════════
-- Every column is added NULLABLE. `agent_runs` already holds V1 history with no
-- trusted principal, repository, or retention binding, and fabricating one for
-- a historical row is exactly what the expand-only rule forbids. Completeness
-- for V2 rows is the conditional agent_runs_v2_identity_check below.
--
-- These are duplicated OUT of `spec` deliberately: security queries and the
-- worker's row/spec identity comparison must not depend on untyped JSON
-- extraction.
ALTER TABLE "agent"."agent_runs"
  ADD COLUMN "spec_version" integer NOT NULL DEFAULT 1,
  ADD COLUMN "run_kind" text NULL,
  ADD COLUMN "spec_digest" text NULL,
  ADD COLUMN "initiating_principal_id" uuid NULL,
  ADD COLUMN "agent_principal_id" uuid NULL,
  ADD COLUMN "agent_id" uuid NULL,
  ADD COLUMN "agent_version_id" uuid NULL,
  ADD COLUMN "agent_version_checksum" text NULL,
  ADD COLUMN "authorization_snapshot_id" uuid NULL,
  ADD COLUMN "parent_run_id" uuid NULL,
  ADD COLUMN "repository_binding_id" uuid NULL,
  ADD COLUMN "repository_provider" text NULL,
  ADD COLUMN "provider_repository_id" text NULL,
  ADD COLUMN "repository_connection_id" uuid NULL,
  ADD COLUMN "configured_default_ref" text NULL,
  ADD COLUMN "base_commit_sha" text NULL,
  ADD COLUMN "base_tree_sha" text NULL,
  ADD COLUMN "retention_policy_id" uuid NULL,
  ADD COLUMN "retention_policy_digest" text NULL,
  ADD COLUMN "max_attempts" integer NULL,
  -- Operational V2 pointers (mutable; see the immutability trigger below).
  ADD COLUMN "active_attempt_id" uuid NULL,
  ADD COLUMN "latest_checkpoint_id" uuid NULL,
  ADD COLUMN "attempt_count" integer NOT NULL DEFAULT 0,
  -- Next run-global event sequence to allocate. Assigned inside the append
  -- transaction (NOT a SEQUENCE object — the allocation must roll back with the
  -- append). Monotonic ACROSS attempts, unlike attempt_seq.
  ADD COLUMN "next_run_seq" bigint NOT NULL DEFAULT 1;

ALTER TABLE "agent"."agent_runs"
  ADD CONSTRAINT "agent_runs_spec_version_check"
    CHECK (spec_version IN (1, 2)),
  -- The V1/V2 discriminant. A preserved V1 row carries NONE of the typed V2
  -- identity; a V2 row carries ALL of it. There is no partially-bound run.
  ADD CONSTRAINT "agent_runs_v2_identity_check" CHECK (
    (
      spec_version = 1
      AND run_kind IS NULL
      AND spec_digest IS NULL
      AND initiating_principal_id IS NULL
      AND agent_principal_id IS NULL
      AND agent_id IS NULL
      AND agent_version_id IS NULL
      AND agent_version_checksum IS NULL
      AND authorization_snapshot_id IS NULL
      AND repository_binding_id IS NULL
      AND repository_provider IS NULL
      AND provider_repository_id IS NULL
      AND repository_connection_id IS NULL
      AND configured_default_ref IS NULL
      AND base_commit_sha IS NULL
      AND base_tree_sha IS NULL
      AND retention_policy_id IS NULL
      AND retention_policy_digest IS NULL
      AND max_attempts IS NULL
    ) OR (
      spec_version = 2
      AND run_kind IS NOT NULL
      AND spec_digest IS NOT NULL
      AND initiating_principal_id IS NOT NULL
      AND agent_principal_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND agent_version_id IS NOT NULL
      AND agent_version_checksum IS NOT NULL
      AND authorization_snapshot_id IS NOT NULL
      AND repository_binding_id IS NOT NULL
      AND repository_provider IS NOT NULL
      AND provider_repository_id IS NOT NULL
      AND repository_connection_id IS NOT NULL
      AND configured_default_ref IS NOT NULL
      AND base_commit_sha IS NOT NULL
      AND base_tree_sha IS NOT NULL
      AND retention_policy_id IS NOT NULL
      AND retention_policy_digest IS NOT NULL
      AND max_attempts IS NOT NULL
    )
  ),
  ADD CONSTRAINT "agent_runs_run_kind_check"
    CHECK (run_kind IS NULL OR run_kind IN ('general', 'repo_edit')),
  ADD CONSTRAINT "agent_runs_spec_digest_check"
    CHECK (spec_digest IS NULL OR spec_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT "agent_runs_retention_digest_check"
    CHECK (retention_policy_digest IS NULL OR retention_policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT "agent_runs_max_attempts_check"
    CHECK (max_attempts IS NULL OR max_attempts > 0),
  ADD CONSTRAINT "agent_runs_attempt_count_check"
    CHECK (attempt_count >= 0 AND (max_attempts IS NULL OR attempt_count <= max_attempts)),
  ADD CONSTRAINT "agent_runs_next_run_seq_check" CHECK (next_run_seq >= 1),
  ADD CONSTRAINT "agent_runs_parent_run_check"
    CHECK (parent_run_id IS NULL OR parent_run_id <> id);

-- V2 claim dispatch: the V2 worker path claims only spec_version = 2 rows and
-- the V1 compatibility path only spec_version = 1, so neither scans the other's
-- queue while both drain.
CREATE INDEX "agent_runs_v2_claim_idx"
  ON "agent"."agent_runs" ("status", "created_at")
  WHERE spec_version = 2 AND status IN ('pending', 'running');
-- Security lookups by trusted identity (who ran what, under which snapshot).
CREATE INDEX "agent_runs_v2_actor_idx"
  ON "agent"."agent_runs" ("org_id", "workspace_id", "initiating_principal_id", "agent_principal_id")
  WHERE spec_version = 2;
CREATE INDEX "agent_runs_parent_run_idx"
  ON "agent"."agent_runs" ("parent_run_id")
  WHERE parent_run_id IS NOT NULL;

-- ── BEFORE UPDATE immutability trigger for V2 rows ───────────────────────────
--
-- agent_runs must stay UPDATE-able: status, pointers, counters, and lifecycle
-- timestamps all advance during a run, so a blanket REVOKE UPDATE is not
-- available the way it is for the append-only tables below. The trigger is what
-- makes the trusted bindings immutable anyway.
--
-- search_path is PINNED (not empty): public_id is `citext`, whose comparison
-- operator lives in the public schema, so an empty search_path would fail
-- operator resolution. A pinned path gives the same protection against
-- search_path injection.
CREATE OR REPLACE FUNCTION "agent"."agent_runs_v2_immutability"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A V1 row may never be re-labelled V2: that would fabricate trusted identity
  -- for history that never had it (the expand-only rule).
  IF OLD.spec_version = 1 AND NEW.spec_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'agent.agent_runs: legacy run % cannot be upgraded to spec_version %',
      OLD.id, NEW.spec_version
      USING ERRCODE = '23514';
  END IF;

  IF OLD.spec_version <> 2 THEN
    RETURN NEW;
  END IF;

  -- Tenant scope, spec + spec digest, actor/version/snapshot/repository/
  -- retention bindings, parent, and engine/attempt policy are all frozen. Only
  -- operational status/result/error/cancellation, the active-attempt and
  -- latest-checkpoint pointers, counters, and lifecycle timestamps may move.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.surface IS DISTINCT FROM OLD.surface
     OR NEW.spec_version IS DISTINCT FROM OLD.spec_version
     OR NEW.spec IS DISTINCT FROM OLD.spec
     OR NEW.run_kind IS DISTINCT FROM OLD.run_kind
     OR NEW.spec_digest IS DISTINCT FROM OLD.spec_digest
     OR NEW.initiating_principal_id IS DISTINCT FROM OLD.initiating_principal_id
     OR NEW.agent_principal_id IS DISTINCT FROM OLD.agent_principal_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id
     OR NEW.agent_version_checksum IS DISTINCT FROM OLD.agent_version_checksum
     OR NEW.authorization_snapshot_id IS DISTINCT FROM OLD.authorization_snapshot_id
     OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
     OR NEW.repository_binding_id IS DISTINCT FROM OLD.repository_binding_id
     OR NEW.repository_provider IS DISTINCT FROM OLD.repository_provider
     OR NEW.provider_repository_id IS DISTINCT FROM OLD.provider_repository_id
     OR NEW.repository_connection_id IS DISTINCT FROM OLD.repository_connection_id
     OR NEW.configured_default_ref IS DISTINCT FROM OLD.configured_default_ref
     OR NEW.base_commit_sha IS DISTINCT FROM OLD.base_commit_sha
     OR NEW.base_tree_sha IS DISTINCT FROM OLD.base_tree_sha
     OR NEW.retention_policy_id IS DISTINCT FROM OLD.retention_policy_id
     OR NEW.retention_policy_digest IS DISTINCT FROM OLD.retention_policy_digest
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
  THEN
    RAISE EXCEPTION
      'agent.agent_runs: immutable RunSpecV2 binding changed on run %', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- Counters advance, never rewind: a rewound attempt_count would let a run
  -- exceed its pinned max_attempts, and a rewound next_run_seq would let two
  -- events claim one run sequence.
  IF NEW.attempt_count < OLD.attempt_count OR NEW.next_run_seq < OLD.next_run_seq THEN
    RAISE EXCEPTION
      'agent.agent_runs: monotonic counter rewound on run %', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "agent_runs_v2_immutability" ON "agent"."agent_runs";
CREATE TRIGGER "agent_runs_v2_immutability"
  BEFORE UPDATE ON "agent"."agent_runs"
  FOR EACH ROW EXECUTE FUNCTION "agent"."agent_runs_v2_immutability"();

-- ════════════════════════════════════════════════════════════════════════════
-- 4. agent.agent_run_events — V1/V2 discriminant
-- ════════════════════════════════════════════════════════════════════════════
-- ADD COLUMN ... DEFAULT 1 backfills every existing row to record version 1 in
-- one pass; no separate UPDATE is needed.
ALTER TABLE "agent"."agent_run_events"
  ADD COLUMN "event_record_version" smallint NOT NULL DEFAULT 1,
  ADD COLUMN "attempt_id" uuid NULL,
  ADD COLUMN "run_seq" bigint NULL,
  ADD COLUMN "attempt_seq" integer NULL,
  ADD COLUMN "event_schema_version" text NULL,
  ADD COLUMN "event_type" text NULL,
  ADD COLUMN "stage" text NULL,
  ADD COLUMN "payload_digest" text NULL,
  ADD COLUMN "event_digest" text NULL,
  -- EXACTLY ONE of these two carries a V2 body. Inline is allow-listed receipt
  -- metadata only; anything large or sensitive is an encrypted blob reference
  -- (an `evb_` public id — app-enforced text; the blob index lands in the
  -- evidence-ledger PR).
  ADD COLUMN "payload_inline" jsonb NULL,
  ADD COLUMN "encrypted_payload_ref" text NULL,
  -- Producer observation time. `created_at` remains the RECORDED time (the
  -- instant Postgres accepted the append); the event digest commits to the
  -- observed one, so both are needed and neither is redundant.
  ADD COLUMN "observed_at" timestamptz NULL;

-- Legacy columns become nullable ONLY as required for the V2 shape. V1 rows
-- still require all three (agent_run_events_record_shape_check below).
ALTER TABLE "agent"."agent_run_events"
  ALTER COLUMN "seq" DROP NOT NULL,
  ALTER COLUMN "type" DROP NOT NULL,
  ALTER COLUMN "payload" DROP NOT NULL;

ALTER TABLE "agent"."agent_run_events"
  ADD CONSTRAINT "agent_run_events_record_version_check"
    CHECK (event_record_version IN (1, 2)),
  -- The discriminant, spelled out. A V1 row is exactly the legacy shape with
  -- every V2 field null; a V2 row is exactly the attempt shape with every
  -- legacy field null. Nothing in between is representable.
  ADD CONSTRAINT "agent_run_events_record_shape_check" CHECK (
    (
      event_record_version = 1
      AND seq IS NOT NULL
      AND type IS NOT NULL
      AND payload IS NOT NULL
      AND attempt_id IS NULL
      AND run_seq IS NULL
      AND attempt_seq IS NULL
      AND event_schema_version IS NULL
      AND event_type IS NULL
      AND stage IS NULL
      AND payload_digest IS NULL
      AND event_digest IS NULL
      AND payload_inline IS NULL
      AND encrypted_payload_ref IS NULL
      AND observed_at IS NULL
    ) OR (
      event_record_version = 2
      AND seq IS NULL
      AND type IS NULL
      AND payload IS NULL
      AND attempt_id IS NOT NULL
      AND run_seq IS NOT NULL
      AND attempt_seq IS NOT NULL
      AND event_schema_version IS NOT NULL
      AND event_type IS NOT NULL
      AND stage IS NOT NULL
      AND payload_digest IS NOT NULL
      AND event_digest IS NOT NULL
      AND observed_at IS NOT NULL
      AND (payload_inline IS NULL) <> (encrypted_payload_ref IS NULL)
    )
  ),
  ADD CONSTRAINT "agent_run_events_stage_check"
    CHECK (stage IS NULL OR stage IN ('admission', 'checkout', 'context', 'model', 'tool', 'change', 'verification', 'provider_publish', 'terminal')),
  ADD CONSTRAINT "agent_run_events_seq_bounds_check"
    CHECK ((run_seq IS NULL OR run_seq >= 1)
       AND (attempt_seq IS NULL OR attempt_seq >= 1)
       AND (seq IS NULL OR seq >= 1)),
  ADD CONSTRAINT "agent_run_events_digest_check"
    CHECK ((payload_digest IS NULL OR payload_digest ~ '^sha256:[0-9a-f]{64}$')
       AND (event_digest IS NULL OR event_digest ~ '^sha256:[0-9a-f]{64}$'));

-- Replace the FULL unique with three PARTIAL uniques. Dropping this is what
-- makes the discriminant load-bearing: a leftover full UNIQUE(run_id, seq)
-- would treat every V2 row's NULL seq as distinct today and silently break the
-- moment anything backfilled it.
ALTER TABLE "agent"."agent_run_events"
  DROP CONSTRAINT IF EXISTS "agent_run_events_run_seq_uq";
CREATE UNIQUE INDEX "agent_run_events_v1_run_seq_uq"
  ON "agent"."agent_run_events" ("run_id", "seq")
  WHERE event_record_version = 1;
CREATE UNIQUE INDEX "agent_run_events_v2_run_seq_uq"
  ON "agent"."agent_run_events" ("run_id", "run_seq")
  WHERE event_record_version = 2;
CREATE UNIQUE INDEX "agent_run_events_v2_attempt_seq_uq"
  ON "agent"."agent_run_events" ("attempt_id", "attempt_seq")
  WHERE event_record_version = 2;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. agent.agent_run_attempts — immutable attempt identity
-- ════════════════════════════════════════════════════════════════════════════
-- One row per successful V2 claim, created BEFORE any model or tool work. The
-- resolved engine name/version/build digest is pinned here rather than read
-- back from a live worker, so evidence names the exact binary that executed.
CREATE TABLE "agent"."agent_run_attempts" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "run_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "worker_id" text NOT NULL,
  "claimed_at" timestamptz NOT NULL DEFAULT now(),
  "engine_name" text NOT NULL,
  "engine_version" text NOT NULL,
  "engine_build_digest" text NOT NULL,
  -- Restore tuple: all four present, or all four absent.
  "resumed_from_attempt_id" uuid NULL,
  "resumed_from_attempt_public_id" citext NULL,
  "restored_checkpoint_id" uuid NULL,
  "restored_checkpoint_digest" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_attempts_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "agent_run_attempts_attempt_number_check" CHECK (attempt_number >= 1),
  -- A partial restore reference cannot prove provenance, so the tuple is
  -- all-or-nothing.
  CONSTRAINT "agent_run_attempts_restore_tuple_check" CHECK (
    (
      resumed_from_attempt_id IS NULL
      AND resumed_from_attempt_public_id IS NULL
      AND restored_checkpoint_id IS NULL
      AND restored_checkpoint_digest IS NULL
    ) OR (
      resumed_from_attempt_id IS NOT NULL
      AND resumed_from_attempt_public_id IS NOT NULL
      AND restored_checkpoint_id IS NOT NULL
      AND restored_checkpoint_digest IS NOT NULL
    )
  ),
  CONSTRAINT "agent_run_attempts_restore_self_check"
    CHECK (resumed_from_attempt_id IS NULL OR resumed_from_attempt_id <> id),
  CONSTRAINT "agent_run_attempts_digest_check"
    CHECK (engine_build_digest ~ '^sha256:[0-9a-f]{64}$'
       AND (restored_checkpoint_digest IS NULL OR restored_checkpoint_digest ~ '^sha256:[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX "agent_run_attempts_run_attempt_uq"
  ON "agent"."agent_run_attempts" ("run_id", "attempt_number");
CREATE INDEX "agent_run_attempts_org_idx"
  ON "agent"."agent_run_attempts" ("org_id", "workspace_id");
CREATE INDEX "agent_run_attempts_run_idx"
  ON "agent"."agent_run_attempts" ("run_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 6. agent.agent_run_attempt_leases — mutable fenced lease
-- ════════════════════════════════════════════════════════════════════════════
-- `lease_epoch` is the fencing token: unique per (run, epoch) and strictly
-- increasing, so a stale worker's late append is rejected at write time exactly
-- like agent.file_lock_fences does for file locks. `fenced_at` is the tombstone
-- the old attempt observes before it may perform any further mutation.
CREATE TABLE "agent"."agent_run_attempt_leases" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  -- Opaque bearer token echoed on every fenced operation. Never derived from
  -- the attempt id — a leaked attempt id must not grant writes.
  "lease_token" text NOT NULL,
  "lease_epoch" bigint NOT NULL,
  "worker_id" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "renewed_at" timestamptz NOT NULL DEFAULT now(),
  "fenced_at" timestamptz NULL,
  "fenced_reason" text NULL,
  "last_run_seq" bigint NULL,
  "last_attempt_seq" integer NULL,
  "event_count" integer NOT NULL DEFAULT 0,
  "final_event_digest" text NULL,
  "event_stream_digest" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_attempt_leases_epoch_check" CHECK (lease_epoch >= 1),
  CONSTRAINT "agent_run_attempt_leases_fence_check"
    CHECK ((fenced_at IS NULL AND fenced_reason IS NULL)
        OR (fenced_at IS NOT NULL AND fenced_reason IS NOT NULL)),
  CONSTRAINT "agent_run_attempt_leases_event_count_check"
    CHECK (event_count >= 0 AND (event_count = 0) = (final_event_digest IS NULL)),
  CONSTRAINT "agent_run_attempt_leases_digest_check"
    CHECK ((final_event_digest IS NULL OR final_event_digest ~ '^sha256:[0-9a-f]{64}$')
       AND (event_stream_digest IS NULL OR event_stream_digest ~ '^sha256:[0-9a-f]{64}$'))
);
-- Exactly one lease per attempt — a second claim must create a new attempt.
CREATE UNIQUE INDEX "agent_run_attempt_leases_attempt_uq"
  ON "agent"."agent_run_attempt_leases" ("attempt_id");
-- The fencing invariant: an epoch is consumed once per run.
CREATE UNIQUE INDEX "agent_run_attempt_leases_run_epoch_uq"
  ON "agent"."agent_run_attempt_leases" ("run_id", "lease_epoch");
CREATE INDEX "agent_run_attempt_leases_org_idx"
  ON "agent"."agent_run_attempt_leases" ("org_id", "workspace_id");
-- Lease-sweeper scan: live (unfenced) leases ordered by expiry. Partial so it
-- stays proportional to running work, not to history.
CREATE INDEX "agent_run_attempt_leases_sweep_idx"
  ON "agent"."agent_run_attempt_leases" ("expires_at")
  WHERE fenced_at IS NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. agent.agent_run_checkpoints — immutable, bound to a final event
-- ════════════════════════════════════════════════════════════════════════════
-- Written in the SAME transaction as the append it terminates. Engine state is
-- never stored here — it is a tenant-encrypted blob referenced by public id, so
-- the row carries identity and digests only.
CREATE TABLE "agent"."agent_run_checkpoints" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "attempt_seq" integer NOT NULL,
  "run_seq" bigint NOT NULL,
  "engine_state_schema" text NOT NULL,
  "checkpoint_digest" text NOT NULL,
  "stream_digest" text NOT NULL,
  "encrypted_state_ref" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_checkpoints_seq_check"
    CHECK (attempt_seq >= 1 AND run_seq >= 1),
  CONSTRAINT "agent_run_checkpoints_digest_check"
    CHECK (checkpoint_digest ~ '^sha256:[0-9a-f]{64}$'
       AND stream_digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "agent_run_checkpoints_attempt_seq_uq"
  ON "agent"."agent_run_checkpoints" ("attempt_id", "attempt_seq");
-- One checkpoint per event at most — the append transaction inserts zero or one.
CREATE UNIQUE INDEX "agent_run_checkpoints_event_uq"
  ON "agent"."agent_run_checkpoints" ("event_id");
CREATE INDEX "agent_run_checkpoints_org_idx"
  ON "agent"."agent_run_checkpoints" ("org_id", "workspace_id");
CREATE INDEX "agent_run_checkpoints_run_seq_idx"
  ON "agent"."agent_run_checkpoints" ("run_id", "run_seq");

-- ════════════════════════════════════════════════════════════════════════════
-- 8. agent.agent_run_attempt_seals — immutable, one per terminated attempt
-- ════════════════════════════════════════════════════════════════════════════
-- Written for EVERY terminal outcome including normal completion — that is what
-- closes the crash window between "finished" and "finalized". A truly zero-event
-- abandoned attempt seals with event_count = 0, a NULL final-event digest, and
-- the canonical empty stream digest; it never invents a terminal event.
CREATE TABLE "agent"."agent_run_attempt_seals" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "terminal_status" text NOT NULL,
  "reason_code" text NULL,
  "event_count" integer NOT NULL,
  "final_run_seq" bigint NULL,
  "final_attempt_seq" integer NULL,
  "final_event_digest" text NULL,
  -- Always present: the canonical empty-stream digest when event_count = 0.
  "event_stream_digest" text NOT NULL,
  "sealer_kind" text NOT NULL,
  "sealer_worker_id" text NOT NULL,
  "sealed_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_attempt_seals_terminal_status_check"
    CHECK (terminal_status IN ('completed', 'failed', 'cancelled', 'denied', 'abandoned')),
  CONSTRAINT "agent_run_attempt_seals_sealer_kind_check"
    CHECK (sealer_kind IN ('worker', 'reclaimer')),
  -- Zero-event seals carry no final-event evidence; non-zero seals carry all of
  -- it. Anything else is an unprovable claim about the stream.
  CONSTRAINT "agent_run_attempt_seals_event_evidence_check" CHECK (
    (
      event_count = 0
      AND final_run_seq IS NULL
      AND final_attempt_seq IS NULL
      AND final_event_digest IS NULL
    ) OR (
      event_count > 0
      AND final_run_seq IS NOT NULL
      AND final_attempt_seq IS NOT NULL
      AND final_event_digest IS NOT NULL
    )
  ),
  CONSTRAINT "agent_run_attempt_seals_digest_check"
    CHECK (event_stream_digest ~ '^sha256:[0-9a-f]{64}$'
       AND (final_event_digest IS NULL OR final_event_digest ~ '^sha256:[0-9a-f]{64}$'))
);
-- An attempt seals exactly once — this uniqueness is what makes the
-- seal/grant/obligation transaction idempotent under duplicate sweeps.
CREATE UNIQUE INDEX "agent_run_attempt_seals_attempt_uq"
  ON "agent"."agent_run_attempt_seals" ("attempt_id");
CREATE INDEX "agent_run_attempt_seals_org_idx"
  ON "agent"."agent_run_attempt_seals" ("org_id", "workspace_id");
CREATE INDEX "agent_run_attempt_seals_run_idx"
  ON "agent"."agent_run_attempt_seals" ("run_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 9. agent.agent_run_finalization_grants — immutable, one-shot, non-expiring
-- ════════════════════════════════════════════════════════════════════════════
-- Minted in the SAME transaction as the seal, for every seal. The `afg_` public
-- id is ALSO the evidence envelope's stable `submission_id`, so every retry of
-- the obligation reuses one submission identity instead of forking a new one.
--
-- NO expiry column by design: the attempt/seal/digest binding plus one
-- successful consumption are the limiting authority, so a KMS or storage outage
-- can never strand an obligation behind an expired grant. Consumption is
-- recorded by the evidence ledger's grant-use row in the next PR; this table is
-- never updated.
CREATE TABLE "agent"."agent_run_finalization_grants" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "run_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "seal_id" uuid NOT NULL,
  "attempt_public_id" citext NOT NULL,
  -- Constrained to exactly one capability — a grant can never execute tools.
  "capability_id" text NOT NULL DEFAULT 'ingest_run_evidence',
  "event_count" integer NOT NULL,
  "final_event_digest" text NULL,
  "event_stream_digest" text NOT NULL,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_finalization_grants_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "agent_run_finalization_grants_capability_check"
    CHECK (capability_id = 'ingest_run_evidence'),
  CONSTRAINT "agent_run_finalization_grants_event_count_check"
    CHECK (event_count >= 0 AND (event_count = 0) = (final_event_digest IS NULL)),
  CONSTRAINT "agent_run_finalization_grants_digest_check"
    CHECK (event_stream_digest ~ '^sha256:[0-9a-f]{64}$'
       AND (final_event_digest IS NULL OR final_event_digest ~ '^sha256:[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX "agent_run_finalization_grants_attempt_uq"
  ON "agent"."agent_run_finalization_grants" ("attempt_id");
CREATE UNIQUE INDEX "agent_run_finalization_grants_seal_uq"
  ON "agent"."agent_run_finalization_grants" ("seal_id");
CREATE INDEX "agent_run_finalization_grants_org_idx"
  ON "agent"."agent_run_finalization_grants" ("org_id", "workspace_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 10. agent.agent_run_finalization_obligations — the durable outbox
-- ════════════════════════════════════════════════════════════════════════════
-- Created in the seal transaction next to the grant. There is deliberately NO
-- `processed_at` column: pending state is DERIVED by anti-joining the evidence
-- ledger's grant-use row, so a crash between "wrote evidence" and "marked done"
-- cannot lose or duplicate an obligation. Mutable retry/claim coordination is a
-- separate table in the evidence-ledger PR — never a mutation of this row.
CREATE TABLE "agent"."agent_run_finalization_obligations" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "grant_id" uuid NOT NULL,
  -- The grant's `afg_` public id, copied verbatim. Stable across every retry.
  "submission_id" citext NOT NULL,
  "run_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "seal_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_run_finalization_obligations_grant_uq"
  ON "agent"."agent_run_finalization_obligations" ("grant_id");
-- `(org_id, submission_id)` is the finalization idempotency key the evidence
-- ledger keys on; enforced here too so a duplicate obligation cannot exist to
-- be double-processed.
CREATE UNIQUE INDEX "agent_run_finalization_obligations_submission_uq"
  ON "agent"."agent_run_finalization_obligations" ("org_id", "submission_id");
CREATE UNIQUE INDEX "agent_run_finalization_obligations_attempt_uq"
  ON "agent"."agent_run_finalization_obligations" ("attempt_id");
CREATE INDEX "agent_run_finalization_obligations_org_idx"
  ON "agent"."agent_run_finalization_obligations" ("org_id", "workspace_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 11. RLS — tenant_isolation (standard class: org_id + workspace_id NOT NULL)
-- ════════════════════════════════════════════════════════════════════════════
-- Append-only privileges stop mutation; they do NOT stop cross-tenant reads.
-- Every table below still needs FORCE ROW LEVEL SECURITY + tenant_isolation.
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.

ALTER TABLE evidence.retention_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.retention_policy_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON evidence.retention_policy_versions;
CREATE POLICY tenant_isolation ON evidence.retention_policy_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE ingestion.repository_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.repository_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.repository_bindings;
CREATE POLICY tenant_isolation ON ingestion.repository_bindings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE ingestion.repository_binding_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.repository_binding_heads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.repository_binding_heads;
CREATE POLICY tenant_isolation ON ingestion.repository_binding_heads
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE ingestion.governed_repository_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.governed_repository_selections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.governed_repository_selections;
CREATE POLICY tenant_isolation ON ingestion.governed_repository_selections
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.agent_run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_run_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_run_attempts;
CREATE POLICY tenant_isolation ON agent.agent_run_attempts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.agent_run_attempt_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_run_attempt_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_run_attempt_leases;
CREATE POLICY tenant_isolation ON agent.agent_run_attempt_leases
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.agent_run_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_run_checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_run_checkpoints;
CREATE POLICY tenant_isolation ON agent.agent_run_checkpoints
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.agent_run_attempt_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_run_attempt_seals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_run_attempt_seals;
CREATE POLICY tenant_isolation ON agent.agent_run_attempt_seals
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.agent_run_finalization_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_run_finalization_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_run_finalization_grants;
CREATE POLICY tenant_isolation ON agent.agent_run_finalization_grants
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.agent_run_finalization_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_run_finalization_obligations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_run_finalization_obligations;
CREATE POLICY tenant_isolation ON agent.agent_run_finalization_obligations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ════════════════════════════════════════════════════════════════════════════
-- 12. oxagen_app privileges — append-only by construction
-- ════════════════════════════════════════════════════════════════════════════
-- Guarded: fresh clusters may lack the role. `REVOKE UPDATE, DELETE` on
-- agent_run_events is safe for the drain window — the only writers are the
-- INSERT and SELECT in packages/agent-runner/src/run-store.ts; nothing in the
-- tree updates or deletes an event row, so no queued V1 work loses authority it
-- needs (spec.md §"Launch changes", item 6).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA evidence TO oxagen_app';

    -- Immutable evidence-bearing rows: SELECT + INSERT, never UPDATE/DELETE.
    EXECUTE 'GRANT SELECT, INSERT ON evidence.retention_policy_versions TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON ingestion.repository_bindings TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON agent.agent_run_attempts TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON agent.agent_run_checkpoints TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON agent.agent_run_attempt_seals TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON agent.agent_run_finalization_grants TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON agent.agent_run_finalization_obligations TO oxagen_app';

    -- Operational state: the documented exception. UPDATE yes, DELETE never.
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON agent.agent_run_attempt_leases TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ingestion.repository_binding_heads TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ingestion.governed_repository_selections TO oxagen_app';

    -- Explicit REVOKEs, even though the GRANTs above are already narrow. The
    -- repo has a blanket `GRANT ... ON ALL TABLES IN SCHEMA` regrant pattern
    -- (20260612052000_regrant_oxagen_app.sql); if it is ever re-run after this
    -- migration, these tables would silently regain UPDATE/DELETE. Stating the
    -- revocation makes the append-only posture an assertion an integration test
    -- can read back from has_table_privilege(), not an emergent property of
    -- grant ordering.
    EXECUTE 'REVOKE UPDATE, DELETE ON evidence.retention_policy_versions FROM oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON ingestion.repository_bindings FROM oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON agent.agent_run_attempts FROM oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON agent.agent_run_checkpoints FROM oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON agent.agent_run_attempt_seals FROM oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON agent.agent_run_finalization_grants FROM oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON agent.agent_run_finalization_obligations FROM oxagen_app';
    EXECUTE 'REVOKE DELETE ON agent.agent_run_attempt_leases FROM oxagen_app';
    EXECUTE 'REVOKE DELETE ON ingestion.repository_binding_heads FROM oxagen_app';
    EXECUTE 'REVOKE DELETE ON ingestion.governed_repository_selections FROM oxagen_app';

    -- The pre-existing event log becomes append-only for V1 and V2 alike.
    EXECUTE 'REVOKE UPDATE, DELETE ON agent.agent_run_events FROM oxagen_app';
  END IF;
END
$$;
