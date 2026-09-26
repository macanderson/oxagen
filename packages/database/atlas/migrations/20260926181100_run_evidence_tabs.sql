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
