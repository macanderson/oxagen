-- The Run page's evidence tabs (batch A5): four changes, one per lane that
-- asked for a column. Every column is nullable and has no default, so no row
-- is rewritten and no row is backfilled. A row written before this reads
-- "not recorded" for each of them.
--
-- NOT VALID on each CHECK: every row that exists when this runs holds NULL in
-- the columns the check reads, which this migration just added, so the check
-- holds for all of them. Validating would scan each table under the ACCESS
-- EXCLUSIVE lock that ingest and the ledger wait on. New and updated rows are
-- checked either way.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The operator's workspace role, stamped when the run opens (#3999,
--    ADR-197).
--
-- A wrapped session's genesis row and a ledger run's insert write the role
-- the operator held in the run's workspace at that moment, lowercased. Nothing
-- updates it, so a later role change does not rewrite what the run says. Null
-- on a run recorded before this column, for an operator who is not a person,
-- and for a person with no membership in the workspace.
ALTER TABLE "tacho"."sessions"
  ADD COLUMN "operator_role" text NULL;

ALTER TABLE "agent"."agent_runs"
  ADD COLUMN "operator_role" text NULL;

ALTER TABLE "tacho"."sessions"
  ADD CONSTRAINT "tacho_sessions_operator_role_check"
  CHECK ("operator_role" IS NULL OR "operator_role" IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer'))
  NOT VALID;

ALTER TABLE "agent"."agent_runs"
  ADD CONSTRAINT "agent_runs_operator_role_check"
  CHECK ("operator_role" IS NULL OR "operator_role" IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer'))
  NOT VALID;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The stored Model fit reading (#3893, ADR-201).
--
-- The `run.fit` job computes the reading from the record after the seal and
-- stores it with its provenance: the rule version, when it was read, and the
-- seal it read. A reading without its provenance cannot be cited, so one CHECK
-- per table sets the four together. A run sealed before this has no reading
-- until it seals again.
ALTER TABLE "tacho"."sessions"
  ADD COLUMN "fit_reading" jsonb NULL,
  ADD COLUMN "fit_method" text NULL,
  ADD COLUMN "fit_read_at" timestamp with time zone NULL,
  ADD COLUMN "fit_sealed_at" timestamp with time zone NULL;

ALTER TABLE "agent"."agent_runs"
  ADD COLUMN "fit_reading" jsonb NULL,
  ADD COLUMN "fit_method" text NULL,
  ADD COLUMN "fit_read_at" timestamp with time zone NULL,
  ADD COLUMN "fit_sealed_at" timestamp with time zone NULL;

ALTER TABLE "tacho"."sessions"
  ADD CONSTRAINT "tacho_sessions_fit_check"
  CHECK ((("fit_reading" IS NULL) = ("fit_method" IS NULL)) AND (("fit_reading" IS NULL) = ("fit_read_at" IS NULL)) AND (("fit_reading" IS NULL) = ("fit_sealed_at" IS NULL)))
  NOT VALID;

ALTER TABLE "agent"."agent_runs"
  ADD CONSTRAINT "agent_runs_fit_check"
  CHECK ((("fit_reading" IS NULL) = ("fit_method" IS NULL)) AND (("fit_reading" IS NULL) = ("fit_read_at" IS NULL)) AND (("fit_reading" IS NULL) = ("fit_sealed_at" IS NULL)))
  NOT VALID;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The seal signs its run attestation when it is written (#4000, ADR-195).
--
-- The seal writes the sha256 of its archive segment as stored, and the
-- attester's key id and base64 Ed25519 signature over the RFC 8785 payload,
-- once, in the row it inserts. The app role keeps no UPDATE on the table, so
-- the three are never rewritten. No backfill: signing an old seal after the
-- fact would attest something it never signed, so an older seal stays
-- unsigned and the export signs it as before.
ALTER TABLE "agent"."agent_run_attempt_seals"
  ADD COLUMN "archive_segment_digest" text NULL,
  ADD COLUMN "attestation_key_id" text NULL,
  ADD COLUMN "attestation_sig" text NULL;

-- A key id and a signature come together. A signature needs the digest it
-- signs, the digest needs the segment it digests, and the digest is sha256.
ALTER TABLE "agent"."agent_run_attempt_seals"
  ADD CONSTRAINT "agent_run_attempt_seals_attestation_check"
  CHECK ((("attestation_key_id" IS NULL) = ("attestation_sig" IS NULL)) AND ("attestation_key_id" IS NULL OR "archive_segment_digest" IS NOT NULL) AND ("archive_segment_digest" IS NULL OR "archive_segment_ref" IS NOT NULL) AND ("archive_segment_digest" IS NULL OR "archive_segment_digest" ~ '^sha256:[0-9a-f]{64}$'))
  NOT VALID;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Graded steps and the agent's baseline on the cost rollup (#3984,
--    ADR-199).
--
-- The rollup grades each step of a run from what its frame recorded and
-- stores the steps that advanced the run and the steps that did not. Null
-- together until the rollup grades the run, and summing to `steps` once it
-- has. A row written before this revives as ungraded until its next rollup.
ALTER TABLE "cost"."run_totals"
  ADD COLUMN "advanced_steps" integer NULL,
  ADD COLUMN "unproductive_steps" integer NULL;

ALTER TABLE "cost"."run_totals"
  ADD CONSTRAINT "run_totals_steps_graded_check"
  CHECK ((("advanced_steps" IS NULL) = ("unproductive_steps" IS NULL)) AND ("advanced_steps" IS NULL OR ("advanced_steps" >= 0 AND "unproductive_steps" >= 0 AND "advanced_steps" + "unproductive_steps" = "steps")))
  NOT VALID;

-- `get_run_cost` answers the agent's baseline beside a run: its sealed runs in
-- the 30 days before the run started. Not CONCURRENTLY: atlas runs a
-- migration in a transaction, and `cost.run_totals` holds one row per run,
-- not one per event.
CREATE INDEX IF NOT EXISTS "run_totals_agent_started_idx"
  ON "cost"."run_totals" ("workspace_id", "agent_key", "started_at");

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The stamped operator role stays as it was stamped (#3999, ADR-197).
--
-- A ledger run writes operator_role once, in its INSERT. The immutability
-- trigger already freezes the run's other bindings on a V2 row, so this adds
-- operator_role to that list: an UPDATE that changes it raises 23514, and a
-- role changed in the workspace after the run started cannot rewrite the run.
-- The function body is the one in 20260813100000_run_attempt_foundation_expand
-- with one condition added. The trigger itself is unchanged and keeps calling
-- this function.
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
  -- retention bindings, parent, engine/attempt policy, and the operator's
  -- stamped workspace role are all frozen. Only
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
     OR NEW.operator_role IS DISTINCT FROM OLD.operator_role
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
