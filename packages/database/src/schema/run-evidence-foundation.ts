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
  check,
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { evidenceSchema } from "./_schemas";
import { appendOnlyAuditMixin, idMixin, orgScopeMixin } from "./_mixins";

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
    ...idMixin("rpv"),
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
