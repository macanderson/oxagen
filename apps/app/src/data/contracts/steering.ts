// The Steering page's view models (#2961; ADR-061; MC spec §10), from
// list_records, list_proposals and get_context_pr. A record is in force
// because a Context PR merged it; a proposal steers nothing; the Context PR
// carries the state machine, its checks and what merge will do. Effect
// metrics, retirement and promotion thresholds have no view model: they are
// not in this release.
import { z } from "zod";
import { PublicId } from "./common";

const Count = z.number().int().nonnegative();
const Instant = z.iso.datetime({ offset: true });

/** One page of records or proposals; the adapter reads this many and the pager steps by it. */
export const STEERING_PAGE = 50;

/** The six kinds of context-record/v0.1 (spec §10.2), in the mockup's order. */
export const RECORD_KINDS = [
  "rule",
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
] as const;
export const RecordKind = z.enum(RECORD_KINDS);
export type RecordKind = z.infer<typeof RecordKind>;

export const RecordForce = z.enum(["must", "should", "may", "info"]);
export type RecordForce = z.infer<typeof RecordForce>;

/** A constraint requires or forbids; a record never grants authority. */
export const ConstraintEffect = z.enum(["require", "forbid"]);
export type ConstraintEffect = z.infer<typeof ConstraintEffect>;

export const SharingScope = z.enum(["repository", "workspace"]);
export type SharingScope = z.infer<typeof SharingScope>;

/** The proposal's state machine (ADR-061 decision 2). */
export const ProposalStatus = z.enum([
  "proposed",
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
  "merged",
  "rejected",
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/** A published record in force. Kind, force, statement, commit and path are null on a record no Context PR wrote. */
const PublishedRecord = z.object({
  id: PublicId,
  /** The lineage the record or proposal is about: the file stem under .oxagen/rules/, not an id. */
  lineage: z.string().min(1),
  title: z.string(),
  kind: RecordKind.nullable(),
  force: RecordForce.nullable(),
  constraintEffect: ConstraintEffect.nullable(),
  sharingScope: SharingScope,
  statement: z.string().nullable(),
  version: z.number().int().positive().nullable(),
  commit: z.string().min(1).nullable(),
  path: z.string().min(1).nullable(),
  publishedAt: Instant.nullable(),
});

export const RecordPage = z.object({
  records: z.array(PublishedRecord),
  /** Every record in force of the kind asked for, ignoring the page. */
  total: Count,
});
export type RecordPage = z.infer<typeof RecordPage>;

export const Proposal = z.object({
  id: PublicId,
  /** The lineage the record or proposal is about: the file stem under .oxagen/rules/, not an id. */
  lineage: z.string().min(1),
  kind: RecordKind,
  force: RecordForce,
  constraintEffect: ConstraintEffect.nullable(),
  sharingScope: SharingScope,
  statement: z.string(),
  rationale: z.string(),
  /** Who raised it: a person, an agent's append or the CLI. */
  source: z.string(),
  support: z.object({
    runs: z.array(z.string()),
    agents: z.array(z.string()),
    recordIds: z.array(z.string()),
    evidenceLinks: z.array(z.string()),
  }),
  status: ProposalStatus,
  /** Null until a Context PR is opened. */
  pr: z
    .object({
      number: z.number().int().positive(),
      repository: z.string().min(1),
      branch: z.string().min(1),
    })
    .nullable(),
  /** Passed of the six checks; null until they first run. */
  checks: z.object({ passed: Count, total: Count }).nullable(),
  updatedAt: Instant,
});
export type Proposal = z.infer<typeof Proposal>;

export const ProposalPage = z.object({
  proposals: z.array(Proposal),
  total: Count,
});
export type ProposalPage = z.infer<typeof ProposalPage>;

/** The six §10.3 checks, in the order they run. */
const CheckName = z.enum([
  "schema",
  "lineage_uniqueness",
  "record_hash",
  "secret_pii_scan",
  "conflict_against_active",
  "constraint_effect",
]);

const GovernanceMode = z.enum(["solo", "team", "regulated"]);

export const ContextPr = z.object({
  proposalId: PublicId,
  /** The lineage the record or proposal is about: the file stem under .oxagen/rules/, not an id. */
  lineage: z.string().min(1),
  status: ProposalStatus,
  /** Read from governance.toml when the pull request opens; null before. */
  governanceMode: GovernanceMode.nullable(),
  pr: z
    .object({
      number: z.number().int().positive(),
      url: z.string().min(1),
      repository: z.string().min(1),
      baseRef: z.string().min(1),
      branch: z.string().min(1),
      /** The commit the checks ran on; null until the file is committed. */
      headSha: z.string().min(1).nullable(),
    })
    .nullable(),
  body: z.string().nullable(),
  checks: z.array(
    z.object({
      name: CheckName,
      status: z.enum(["pending", "running", "passed", "failed"]),
      summary: z.string(),
    }),
  ),
  onMerge: z.object({
    /** The record file merge publishes. */
    path: z.string().min(1),
    /** The workspace's steering version, the promotion ledger's length, now and after merge. */
    bundleVersion: z.object({ current: Count, afterMerge: Count }),
  }),
  merged: z
    .object({
      commit: z.string().min(1),
      at: Instant,
      promotionEventId: PublicId,
      recordId: PublicId,
    })
    .nullable(),
});
export type ContextPr = z.infer<typeof ContextPr>;

/**
 * The freshness panel on the Steering page: what the workspace has published,
 * where it lives, and the two gates every agent a member runs answers to.
 *
 * `repository` is null while no repository is bound, which is the state in
 * which steering is off for the workspace entirely. The panel says so rather
 * than showing two switches that could not take effect.
 */
export const SteeringFreshness = z.object({
  /** The promotion ledger's length. */
  version: Count,
  /** The production-branch commit the newest record published at. */
  headCommit: z.string().min(1).nullable(),
  publishedAt: Instant.nullable(),
  /** `owner/repo`, and the branch a Context PR targets. Null until one is bound. */
  repository: z.string().min(1).nullable(),
  defaultBranch: z.string().min(1).nullable(),
  gates: z.object({
    autoSync: z.boolean(),
    blockStaleRuns: z.boolean(),
  }),
});
export type SteeringFreshness = z.infer<typeof SteeringFreshness>;
