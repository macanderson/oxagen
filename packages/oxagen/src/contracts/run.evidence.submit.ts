import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * run.evidence.submit → submit_run_evidence
 *
 * The narrow, authenticated ingestion path for a RunEvidenceManifestV1 — the
 * immutable evidence bridge between Stella's local working-code graph and
 * Oxagen's governed workspace graph
 * (docs/specs/workspace-graph-boundary/spec.md §"The immutable evidence bridge",
 * §"What to delete or replace" → "a narrow, authenticated RunEvidenceManifestV1
 * ingestion path for Stella, distinct from generic graph mutation").
 *
 * This is deliberately NOT the deleted `push_graph` capability: it accepts no
 * arbitrary labels, edges, embeddings, or tombstones — only a typed manifest of
 * commit/file/context/verification facts for one governed agent attempt.
 *
 * LAUNCH INVARIANT 4 — "No client can author canonical provider-observed or
 * runner-observed evidence." The input carries NO `evidenceAuthority`; the
 * handler stamps it server-side as 'client_attested', always. A standalone
 * Stella client's upload is attested-but-unverified by construction.
 *
 * Idempotent: an identical resubmission (same canonical manifest content →
 * same digest) returns the existing manifest with `deduplicated: true` and never
 * writes a second immutable row.
 *
 * Org + workspace scoped, metered, IAM-gated. Surfaces: api / mcp / cli.
 */

const looseReceipt = z
  .record(z.string(), z.unknown())
  .describe("Opaque receipt record retained verbatim in the manifest payload");

// ── LocalCheckoutSnapshotV1 (spec §"Stella's local graph") ─────────────────────
// The attestable local generation identity that framed the run (launch invariant
// 6). Branch names and absolute paths are annotations, NOT identity — they are
// deliberately absent. `repositoryId` is the resolved Oxagen repository uuid.
const localCheckoutSnapshotSchema = z.object({
  repositoryId: z
    .string()
    .uuid()
    .optional()
    .describe("Resolved Oxagen code_repositories id this checkout is of"),
  baseCommitSha: z
    .string()
    .min(1)
    .describe(
      "Canonical commit SHA the checkout is based on (snapshot identity)",
    ),
  headCommitSha: z.string().optional(),
  headTreeSha: z.string().optional(),
  dirtyPatchDigest: z
    .string()
    .optional()
    .describe("Digest of the uncommitted working-tree patch"),
  untrackedManifestDigest: z
    .string()
    .optional()
    .describe("Digest of the untracked-file manifest"),
  graphGenerationId: z
    .string()
    .optional()
    .describe("Stella local graph generation id that indexed this checkout"),
  graphSchemaVersion: z.string().optional(),
  extractorVersion: z.string().optional(),
  indexedRootDigest: z.string().optional(),
  completedAt: z
    .string()
    .datetime()
    .optional()
    .describe("When Stella finished indexing this checkout (ISO 8601)"),
  freshnessStatus: z.string().optional(),
});

// ── Context-frame manifest entry (spec §"context.frame", launch invariant 7) ───
const contextFrameSchema = z.object({
  providerId: z
    .string()
    .min(1)
    .describe("CGP provider that supplied the frame"),
  frameId: z.string().min(1).describe("Provider-scoped frame id"),
  uri: z.string().optional().describe("Frame source URI"),
  canonicalContentDigest: z
    .string()
    .min(1)
    .describe("Digest of the exact canonical content admitted to the frame"),
  localGraphGenerationId: z.string().optional(),
  authorizationDecisionId: z
    .string()
    .optional()
    .describe("The authorization decision that admitted this frame"),
  retentionMode: z
    .enum(["hash_only", "content_retained"])
    .describe(
      "hash_only → structural/verifiable replay; content_retained → content-exact replay",
    ),
  tokenCost: z.number().int().nonnegative().optional(),
});

// ── Changed-file evidence (spec §"changes[]", launch invariants 5 + 8) ─────────
const runEvidenceChangeSchema = z.object({
  repositoryId: z
    .string()
    .uuid()
    .optional()
    .describe("Resolved Oxagen code_repositories id the change is in"),
  pathLocator: z
    .string()
    .min(1)
    .describe("Changed path, or a tenant HMAC of it when paths are encrypted"),
  changeKind: z.enum(["added", "modified", "deleted", "renamed"]),
  beforeDigest: z.string().optional(),
  afterDigest: z.string().optional(),
  codeScopeId: z
    .string()
    .uuid()
    .optional()
    .describe("Resolved code_scopes id, or omitted when unresolved"),
  domainSlug: z.string().optional(),
});

export const runEvidenceSubmit = registerCapability({
  name: "submit_run_evidence",
  domain: "run",
  description:
    "Submit a RunEvidenceManifestV1 for one governed agent attempt — the immutable, commit-addressed record of its checkout, context frames, changed files, commits, PRs, tool/approval/verification receipts, and artifacts. Idempotent; always stamped 'client_attested'.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "ingestion",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    runId: z
      .string()
      .min(1)
      .describe("Run this evidence attests (opaque runner id)"),
    attemptId: z
      .string()
      .optional()
      .describe("Attempt within the run; distinct manifests per attempt"),
    principals: z
      .object({
        initiatingPrincipalId: z
          .string()
          .min(1)
          .describe("Principal that initiated the run"),
        agentPrincipalId: z
          .string()
          .optional()
          .describe("Agent principal that executed the run"),
      })
      .describe("Identity attestation for the run"),
    agentVersionId: z.string().optional(),
    authorizationSnapshotId: z.string().optional(),
    localCheckoutSnapshot: localCheckoutSnapshotSchema.describe(
      "The local checkout + graph generation that framed the run (invariant 6)",
    ),
    context: z
      .object({
        compiledFrameManifestDigest: z
          .string()
          .optional()
          .describe("Digest of the compiled context-frame manifest"),
        frames: z
          .array(contextFrameSchema)
          .default([])
          .describe("Selected CGP frames shown to the model"),
      })
      .optional(),
    changes: z
      .array(runEvidenceChangeSchema)
      .default([])
      .describe("File-level before/after change evidence"),
    commits: z.array(looseReceipt).default([]),
    pullRequestReceipts: z.array(looseReceipt).default([]),
    toolReceipts: z.array(looseReceipt).default([]),
    approvalReceipts: z.array(looseReceipt).default([]),
    verificationReceipts: z.array(looseReceipt).default([]),
    artifactDigests: z
      .array(z.string())
      .default([])
      .describe("Content digests of produced artifacts"),
  }),
  output: z.object({
    manifestId: z
      .string()
      .describe("publicId of the stored (or pre-existing) evidence manifest"),
    manifestDigest: z
      .string()
      .describe("sha256 of the canonical manifest content"),
    deduplicated: z
      .boolean()
      .describe(
        "True when an identical manifest already existed (no new write)",
      ),
  }),
});

export type RunEvidenceSubmitInput = z.output<typeof runEvidenceSubmit.input>;
export type RunEvidenceSubmitOutput = z.output<typeof runEvidenceSubmit.output>;
