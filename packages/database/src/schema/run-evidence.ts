import {
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import { appendOnlyAuditMixin, idMixin, orgScopeMixin } from "./_mixins";

// ── The immutable evidence bridge — RunEvidenceManifestV1 ledger ───────────────
//
// The exact commit/file/context/verification facts for EVERY governed agent
// attempt, retained immutably even when the workspace graph presents only
// domain-level topology and even when the run's work never merges
// (docs/specs/workspace-graph-boundary/spec.md §"The immutable evidence bridge",
// §"What may flow upward", launch invariants 4, 6, 8, 10).
//
// Lives in the `agent` schema beside `agent_runs` (its subject is a run), reusing
// the existing schema rather than minting a new one — mirroring
// 20260804100000_agent_runs_durable_schema.sql. Every table carries
// org_id + workspace_id (orgScopeMixin) for the shared `tenant_isolation` RLS
// policy, same as agent_run_events.
//
// APPEND-ONLY: no updated_at, no soft delete. The ledger is never rewritten; a
// corrected manifest is a NEW manifest with a new digest. Identity fields
// (run_id, principals, version/authorization ids) are `text`, not `uuid`: a
// standalone Stella client attests these and they are NOT independently verified
// (evidence_authority = 'client_attested'), so a strict uuid column would reject
// legitimate attested payloads. Links to the code projection
// (checkout_repository_id, changes.repository_id, changes.code_scope_id) are
// cross-schema (ingestion) → app-enforced plain uuids per the storage rules;
// the manifest→change / manifest→frame links are within-schema real FKs.

// ── Explicit evidence-authority levels — never merged into one "truth" edge ────
// (spec §"The immutable evidence bridge"). A client-uploaded manifest can ONLY
// ever be 'client_attested'; the handler stamps this server-side and refuses to
// let a caller author 'runner_observed'/'provider_observed' (launch invariant 4).
export const RUN_EVIDENCE_AUTHORITIES = [
  "runner_observed",
  "provider_observed",
  "client_attested",
  "inferred",
] as const;
export type RunEvidenceAuthority = (typeof RUN_EVIDENCE_AUTHORITIES)[number];

// ── agent.run_evidence_manifests ───────────────────────────────────────────────
export const runEvidenceManifests = agentSchema.table(
  "run_evidence_manifests",
  {
    ...idMixin("rem"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    // The run + attempt this evidence attests. Opaque runner ids (text).
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id"),
    // Identity attestation (spec §"What may flow upward"). initiating principal
    // is always known (the caller); the rest are optional at launch.
    initiatingPrincipalId: text("initiating_principal_id").notNull(),
    agentPrincipalId: text("agent_principal_id"),
    agentVersionId: text("agent_version_id"),
    authorizationSnapshotId: text("authorization_snapshot_id"),
    // ── LocalCheckoutSnapshotV1 (spec §"Stella's local graph") as typed columns.
    // Cross-schema link to ingestion.code_repositories — app-enforced uuid.
    checkoutRepositoryId: uuid("checkout_repository_id"),
    baseCommitSha: text("base_commit_sha"),
    headCommitSha: text("head_commit_sha"),
    headTreeSha: text("head_tree_sha"),
    dirtyPatchDigest: text("dirty_patch_digest"),
    untrackedManifestDigest: text("untracked_manifest_digest"),
    graphGenerationId: text("graph_generation_id"),
    graphSchemaVersion: text("graph_schema_version"),
    extractorVersion: text("extractor_version"),
    indexedRootDigest: text("indexed_root_digest"),
    checkoutCompletedAt: timestamp("checkout_completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    freshnessStatus: text("freshness_status"),
    // Authority stamped server-side; CHECK gates the vocabulary. Client uploads
    // are always 'client_attested' (launch invariant 4).
    evidenceAuthority: text("evidence_authority")
      .notNull()
      .default("client_attested"),
    // sha256 of the canonical-JSON of the client input manifest ONLY (excludes
    // server-added authority/created_at/id), so an identical resubmission
    // produces an identical digest and dedupes.
    manifestDigest: text("manifest_digest").notNull(),
    // The full attested manifest (commits[], pull_request_receipts[],
    // tool_receipts[], approval_receipts[], verification_receipts[],
    // artifact_digests[], and the normalized-out changes/frames too).
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    // Idempotent resubmission key. NULLS NOT DISTINCT so a null attempt_id still
    // dedupes on (org, run, digest) — default NULLS DISTINCT would let identical
    // null-attempt manifests insert twice.
    idempotencyUniq: unique("run_evidence_manifests_idempotency_uq")
      .on(t.orgId, t.runId, t.attemptId, t.manifestDigest)
      .nullsNotDistinct(),
    orgRunIdx: index("run_evidence_manifests_org_run_idx").on(t.orgId, t.runId),
    workspaceOrgIdx: index("run_evidence_manifests_workspace_org_idx").on(
      t.workspaceId,
      t.orgId,
    ),
    checkoutRepositoryIdx: index(
      "run_evidence_manifests_checkout_repository_idx",
    ).on(t.checkoutRepositoryId),
    authorityCheck: check(
      "run_evidence_manifests_authority_check",
      sql`${t.evidenceAuthority} IN ('runner_observed', 'provider_observed', 'client_attested', 'inferred')`,
    ),
  }),
);

// ── agent.run_evidence_changes ─────────────────────────────────────────────────
//
// File-level before/after mutation evidence for a manifest (launch invariant 8:
// "Every mutating run records file-level before/after evidence somewhere"). The
// path may be a tenant-HMAC rather than a plaintext path (spec §"What may flow
// upward"). code_scope_id / domain_slug map the locator to a versioned scope or
// leave it unresolved (invariant 5) — never silently to the current default ref.
export const runEvidenceChanges = agentSchema.table(
  "run_evidence_changes",
  {
    ...idMixin("rec"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => runEvidenceManifests.id),
    // Cross-schema link to ingestion.code_repositories — app-enforced uuid.
    repositoryId: uuid("repository_id"),
    // Plaintext path OR tenant HMAC of the path.
    pathLocator: text("path_locator").notNull(),
    changeKind: text("change_kind").notNull(),
    beforeDigest: text("before_digest"),
    afterDigest: text("after_digest"),
    // Cross-schema link to ingestion.code_scopes — app-enforced uuid.
    codeScopeId: uuid("code_scope_id"),
    domainSlug: text("domain_slug"),
  },
  (t) => ({
    manifestIdx: index("run_evidence_changes_manifest_idx").on(t.manifestId),
    repositoryPathIdx: index("run_evidence_changes_repository_path_idx").on(
      t.repositoryId,
      t.pathLocator,
    ),
    changeKindCheck: check(
      "run_evidence_changes_change_kind_check",
      sql`${t.changeKind} IN ('added', 'modified', 'deleted', 'renamed')`,
    ),
  }),
);

// ── agent.run_context_frames ───────────────────────────────────────────────────
//
// The compiled Context-Frame manifest actually shown to the model, one row per
// selected CGP frame (launch invariant 7: "Every selected CGP frame records
// provenance, content digest, authorization decision, and retention mode").
// retention_mode distinguishes structural/verifiable replay (hash_only) from
// content-exact replay (content_retained) — see spec §"What may flow upward"
// replay tradeoff.
export const runContextFrames = agentSchema.table(
  "run_context_frames",
  {
    ...idMixin("rcf"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => runEvidenceManifests.id),
    providerId: text("provider_id").notNull(),
    frameId: text("frame_id").notNull(),
    uri: text("uri"),
    canonicalContentDigest: text("canonical_content_digest").notNull(),
    localGraphGenerationId: text("local_graph_generation_id"),
    authorizationDecisionId: text("authorization_decision_id"),
    retentionMode: text("retention_mode").notNull(),
    tokenCost: integer("token_cost"),
  },
  (t) => ({
    manifestIdx: index("run_context_frames_manifest_idx").on(t.manifestId),
    retentionModeCheck: check(
      "run_context_frames_retention_mode_check",
      sql`${t.retentionMode} IN ('hash_only', 'content_retained')`,
    ),
  }),
);
