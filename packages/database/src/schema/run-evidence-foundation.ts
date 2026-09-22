// run-evidence-foundation.ts — the `evidence` domain's foundation table plus
// the shared vocabularies the governed-run foundation uses across the `agent`,
// `iam`, and `ingestion` domains.
//
// docs/specs/run-evidence-ingress/spec.md is the source of truth. The tables
// that actually hold run/attempt/authorization state live with their domain
// siblings (schema/agent.ts, schema/iam.ts, schema/ingestion.ts) because the
// Postgres schema name IS the domain in this repo — one file per pg schema. The
// only table that belongs to the new `evidence` schema at foundation time is
// `evidence.retention_policy_versions`; the manifest/blob ledger is planned in
// docs/specs/run-evidence-ingress/03-evidence-ledger-plan.md.
//
// Everything else exported here is vocabulary — the closed value sets that CHECK
// constraints and application code must agree on. Keeping them in one module
// means a stage or status can never be spelled two ways across three schemas.

import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  DISCLOSURE_GRAINS,
  ORACLE_KINDS,
  PROOF_VERDICTS,
  TAMPER_EXCLUSIONS,
  WITNESS_RESULTS,
} from "@oxagen/run-evidence";
import { evidenceSchema } from "./_schemas";
import {
  appendOnlyAuditMixin,
  auditMixin,
  hexIdMixin,
  idMixin,
  orgScopeMixin,
  uuidv7Default,
} from "./_mixins";

// ---------------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------------

/**
 * The nine evidence stages every durable V2 event is stamped with
 * (spec.md §"StageCoverageV1"). Ordered as execution reaches them.
 */
export const EVIDENCE_STAGES = [
  "admission",
  "checkout",
  "context",
  "model",
  "tool",
  "change",
  "verification",
  "provider_publish",
  "terminal",
] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

/**
 * Trusted `RunSpecV2.run_kind`. `repo_edit` is the governed code-mode surface
 * the first vertical slice targets; `general` is every other governed run.
 */
export const RUN_KINDS = ["general", "repo_edit"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * Terminal status of a sealed attempt. `abandoned` is the lease-reclaimer's
 * seal for an attempt whose worker disappeared; `denied` is an authorization
 * refusal. Every one of them finalizes evidence (spec.md §"Attempt identity").
 */
export const ATTEMPT_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "denied",
  "abandoned",
] as const;
export type AttemptTerminalStatus = (typeof ATTEMPT_TERMINAL_STATUSES)[number];

/**
 * Who sealed an attempt. `worker` is the executing worker's own terminal path;
 * `reclaimer` is the lease sweeper sealing an expired attempt it fenced.
 */
export const ATTEMPT_SEALER_KINDS = ["worker", "reclaimer"] as const;
export type AttemptSealerKind = (typeof ATTEMPT_SEALER_KINDS)[number];

/**
 * Retention modes a pinned retention-policy version may declare, in increasing
 * order of what replay can prove (spec.md §"Replay grades").
 */
export const RETENTION_MODES = [
  "digest_only",
  "content_exact",
  "environment_restore",
] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

/**
 * Outcomes of one persisted authorization decision. Every governed operation
 * records exactly one of these — including evaluation errors, which deny.
 */
export const AUTHORIZATION_OUTCOMES = [
  "allow",
  "deny",
  "approval_pending",
  "error",
] as const;
export type AuthorizationOutcome = (typeof AUTHORIZATION_OUTCOMES)[number];

/**
 * The single capability a finalization grant may ever authorize. It is stored
 * (not implied) so a misuse is visible in the row itself, and constrained by a
 * CHECK so a grant can never be minted for anything else.
 */
export const FINALIZATION_GRANT_CAPABILITY = "ingest_run_evidence";

/**
 * Canonical SHA-256 digest form used at every evidence boundary. Algorithm
 * qualified and lowercase-hex so a digest is self-describing after export.
 * Mirrored verbatim in the migration's CHECK constraints — keep them in sync.
 */
export const SHA256_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";

// ---------------------------------------------------------------------------
// evidence.retention_policy_versions — immutable, tenant-scoped policy versions
// ---------------------------------------------------------------------------
//
// Admission pins ONE exact (public_id, policy_digest) pair into the run row and
// the serialized spec. A policy edit inserts a new version; it never rewrites an
// admitted one, so a producer can never upgrade itself from digest-only to exact
// retention after the fact (spec.md §"Security and retention rules").
//
// Immutable: append-only audit columns (no updated_at / deleted_at) and the
// migration revokes UPDATE/DELETE from the application role.
export const retentionPolicyVersions = evidenceSchema.table(
  "retention_policy_versions",
  {
    ...hexIdMixin("rpv"),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    // Monotonically increasing per (org, workspace). Version 1 is the first
    // policy a workspace ever pins; a rename/mode change appends the next.
    version: integer("version").notNull(),
    mode: text("mode").notNull(),
    // Content classes this policy authorizes retaining exact bytes for (e.g.
    // "model_request", "tool_output"). An empty array is legal and means
    // digest-only in practice even when `mode` allows more.
    retainedContentClasses: text("retained_content_classes")
      .array()
      .notNull()
      .default(sql`'{}'`),
    // Retention window for exact payloads, in days. Digests and the manifest
    // index outlive it — only the encrypted blobs are crypto-shredded.
    ttlDays: integer("ttl_days").notNull(),
    // Declarative rule describing what an environment-restore replay may
    // rebuild (image/tooling pins). `{}` when the mode does not support it.
    environmentRestorationRule: jsonb("environment_restoration_rule")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // RFC 8785 canonical digest over the policy body. Pinned at admission
    // alongside public_id so a swapped row is detectable.
    policyDigest: text("policy_digest").notNull(),
  },
  (t) => ({
    versionUniq: uniqueIndex("retention_policy_versions_version_uniq").on(
      t.orgId,
      t.workspaceId,
      t.version,
    ),
    // One canonical row per policy body per tenant — re-declaring the same
    // policy must resolve to the existing version rather than fork the digest.
    digestUniq: uniqueIndex("retention_policy_versions_digest_uniq").on(
      t.orgId,
      t.workspaceId,
      t.policyDigest,
    ),
    orgIdx: index("retention_policy_versions_org_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    modeCheck: check(
      "retention_policy_versions_mode_check",
      sql`${t.mode} IN ('digest_only', 'content_exact', 'environment_restore')`,
    ),
    versionCheck: check(
      "retention_policy_versions_version_check",
      sql`${t.version} > 0`,
    ),
    ttlCheck: check(
      "retention_policy_versions_ttl_check",
      sql`${t.ttlDays} > 0`,
    ),
    digestCheck: check(
      "retention_policy_versions_digest_check",
      sql`${t.policyDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

export type RetentionPolicyVersion =
  typeof retentionPolicyVersions.$inferSelect;
export type NewRetentionPolicyVersion =
  typeof retentionPolicyVersions.$inferInsert;

// ---------------------------------------------------------------------------
// evidence.run_exports — the export job `export_run` queues (spec App. E)
// ---------------------------------------------------------------------------
//
// One row per requested bundle. The job builds the bundle (the frame
// envelopes as NDJSON, the Merkle root, the attestation, the verifier script)
// into the organisation's object store and records where it landed; the row
// is what Audit › exports lists. Mutable by design: `status` moves from
// `queued` through `building` to `ready` or `failed`, and every other column
// is written once. ADR-058.
export const RUN_EXPORT_STATUSES = [
  "queued",
  "building",
  "ready",
  "failed",
] as const;
export type RunExportStatus = (typeof RUN_EXPORT_STATUSES)[number];

export const runExports = evidenceSchema.table(
  "run_exports",
  {
    ...idMixin("rexp"),
    ...orgScopeMixin(),
    ...auditMixin(),
    // The run's public id (`arun_…` or `tse_…`): the export names the run the
    // way every surface does, whichever store minted it.
    runPublicId: text("run_public_id").notNull(),
    // The signed-in user who asked; the attestation names them.
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    status: text("status").notNull().default("queued"),
    // Set together when the bundle is ready: where it is, its digest, its size,
    // and the Merkle root and frame count the attestation commits to.
    bundleRef: text("bundle_ref"),
    bundleDigest: text("bundle_digest"),
    // Null on a bundle built before the size was recorded (20260922150000).
    bundleBytes: integer("bundle_bytes"),
    merkleRoot: text("merkle_root"),
    frameCount: integer("frame_count"),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Set when `status = 'failed'`.
    error: text("error"),
  },
  (t) => ({
    orgIdx: index("run_exports_org_idx").on(
      t.orgId,
      t.workspaceId,
      t.createdAt,
    ),
    runIdx: index("run_exports_run_idx").on(t.runPublicId),
    statusCheck: check(
      "run_exports_status_check",
      sql`${t.status} IN ('queued', 'building', 'ready', 'failed')`,
    ),
    readyCheck: check(
      "run_exports_ready_check",
      sql`(${t.status} = 'ready') = (${t.bundleRef} IS NOT NULL AND ${t.bundleDigest} IS NOT NULL AND ${t.merkleRoot} IS NOT NULL AND ${t.frameCount} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
    ),
    failedCheck: check(
      "run_exports_failed_check",
      sql`(${t.status} = 'failed') = (${t.error} IS NOT NULL)`,
    ),
    digestCheck: check(
      "run_exports_digest_check",
      sql`(${t.bundleDigest} IS NULL OR ${t.bundleDigest} ~ '^sha256:[0-9a-f]{64}$') AND (${t.merkleRoot} IS NULL OR ${t.merkleRoot} ~ '^sha256:[0-9a-f]{64}$') AND (${t.frameCount} IS NULL OR ${t.frameCount} >= 0) AND (${t.bundleBytes} IS NULL OR ${t.bundleBytes} >= 0)`,
    ),
  }),
);

export type RunExport = typeof runExports.$inferSelect;
export type NewRunExport = typeof runExports.$inferInsert;

// ---------------------------------------------------------------------------
// Proof: witnesses, verdicts, the disclosure grain (spec §8.5, ADR-064)
// ---------------------------------------------------------------------------
//
// A witness is a check the worker never sees; its verdict lands on the
// worker's run as a `proof.observed` frame, and `ingest_tacho_events` writes
// one `verdicts` row per such frame. Both tables are records: the app role
// may insert and read them, never rewrite or delete them. The run's verdict
// on `cost.run_totals` is aggregated from these rows when the rollup rebuilds
// the run (`aggregateRunVerdict`, @oxagen/run-evidence).

const quoted = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(", "));

/** One row per witness a workspace has seen a verdict for. Its identity is immutable. */
export const witnesses = evidenceSchema.table(
  "witnesses",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    // The producer's id (`wit_…`), unique per workspace.
    witnessId: text("witness_id").notNull(),
    oracleKind: text("oracle_kind").notNull(),
    // The normalized command's digest; the command itself never leaves the runner.
    commandDigest: text("command_digest").notNull(),
    // Held out: reported to the record, never to the worker.
    heldOut: boolean("held_out").notNull(),
  },
  (t) => ({
    witnessUniq: uniqueIndex("witnesses_witness_uniq").on(
      t.orgId,
      t.workspaceId,
      t.witnessId,
    ),
    oracleCheck: check(
      "witnesses_oracle_kind_check",
      sql`${t.oracleKind} IN (${quoted(ORACLE_KINDS)})`,
    ),
    digestCheck: check(
      "witnesses_command_digest_check",
      sql`${t.commandDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

/** One row per `proof.observed` frame: one attempt of one witness on one run. */
export const verdicts = evidenceSchema.table(
  "verdicts",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...appendOnlyAuditMixin(),
    // The worker's run (`arun_…` or `tse_…`, a root session for a wrapped
    // run), the session whose chain carried the frame, and its seq there:
    // a subagent's frames are part of its root's run and number from 0.
    runId: text("run_id").notNull(),
    sessionUuid: uuid("session_uuid").notNull(),
    frameSeq: bigint("frame_seq", { mode: "number" }).notNull(),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    witnessId: text("witness_id").notNull(),
    // 1-based, in frame order, per (run, witness).
    attemptNo: integer("attempt_no").notNull(),
    // The witness's own run; null when the producer recorded none.
    witnessRunId: text("witness_run_id"),
    targetRef: text("target_ref").notNull(),
    targetSha: text("target_sha").notNull(),
    prRef: text("pr_ref").notNull(),
    prSha: text("pr_sha").notNull(),
    targetResult: text("target_result").notNull(),
    prResult: text("pr_result").notNull(),
    verdict: text("verdict").notNull(),
    failFingerprint: text("fail_fingerprint"),
    passOutputDigest: text("pass_output_digest"),
    tamperExclusion: text("tamper_exclusion").notNull(),
    // { fingerprint_authored, fingerprint_at_run } when the exclusion broke.
    tamper: jsonb("tamper"),
    disclosureGrain: text("disclosure_grain").notNull(),
    // { key_id, signature }: the runner's signed statement of what it ran.
    runnerAttestation: jsonb("runner_attestation").notNull(),
  },
  (t) => ({
    frameUniq: uniqueIndex("verdicts_frame_uniq").on(
      t.orgId,
      t.workspaceId,
      t.runId,
      t.sessionUuid,
      t.frameSeq,
    ),
    attemptUniq: uniqueIndex("verdicts_attempt_uniq").on(
      t.orgId,
      t.workspaceId,
      t.runId,
      t.witnessId,
      t.attemptNo,
    ),
    witnessRunIdx: index("verdicts_witness_run_idx").on(
      t.orgId,
      t.workspaceId,
      t.witnessRunId,
    ),
    witnessFk: foreignKey({
      name: "verdicts_witness_fk",
      columns: [t.orgId, t.workspaceId, t.witnessId],
      foreignColumns: [
        witnesses.orgId,
        witnesses.workspaceId,
        witnesses.witnessId,
      ],
    }),
    verdictCheck: check(
      "verdicts_verdict_check",
      sql`${t.verdict} IN (${quoted(PROOF_VERDICTS)})`,
    ),
    resultCheck: check(
      "verdicts_result_check",
      sql`${t.targetResult} IN (${quoted(WITNESS_RESULTS)}) AND ${t.prResult} IN (${quoted(WITNESS_RESULTS)})`,
    ),
    grainCheck: check(
      "verdicts_disclosure_grain_check",
      sql`${t.disclosureGrain} IN (${quoted(DISCLOSURE_GRAINS)})`,
    ),
    tamperCheck: check(
      "verdicts_tamper_check",
      sql`${t.tamperExclusion} IN (${quoted(TAMPER_EXCLUSIONS)}) AND (${t.tamperExclusion} = 'broken') = (${t.verdict} = 'tampered') AND (${t.tamper} IS NOT NULL) = (${t.tamperExclusion} = 'broken')`,
    ),
    // Only a fail on the target and a pass on the head, with the fingerprint
    // held, is a flip.
    flipCheck: check(
      "verdicts_flip_check",
      sql`${t.verdict} <> 'flipped' OR (${t.targetResult} = 'fail' AND ${t.prResult} = 'pass')`,
    ),
    attemptCheck: check("verdicts_attempt_check", sql`${t.attemptNo} > 0`),
  }),
);

/**
 * The workspace's disclosure grain (spec §8.5 invariant 3). No row is `L0`.
 * Changing it is `set_disclosure_grain`, an Owner or Admin in a signed-in
 * session, recorded as `evidence.disclosure_grain_changed`.
 */
export const disclosurePolicies = evidenceSchema.table(
  "disclosure_policies",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...orgScopeMixin(),
    ...auditMixin(),
    grain: text("grain").notNull(),
  },
  (t) => ({
    workspaceUniq: uniqueIndex("disclosure_policies_workspace_uniq").on(
      t.orgId,
      t.workspaceId,
    ),
    grainCheck: check(
      "disclosure_policies_grain_check",
      sql`${t.grain} IN (${quoted(DISCLOSURE_GRAINS)})`,
    ),
  }),
);
