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
/** The most rows one list_records call answers (its contract's `limit` bound). */
export const STEERING_READ_MAX = 200;

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
  label: z.string().optional(),
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

/**
 * One published record's page (#3395; MC spec §10.2), from `get_record`.
 *
 * `backing` says where the bytes came from. `file` means the record was read
 * back out of `.oxagen/rules/<lineage>.toml` on the production branch, which
 * is what actually steers a run; `registry` means the Postgres mirror
 * answered because the repository could not. The page prints the difference
 * rather than hiding it, because a reader deciding whether to trust a rule
 * needs to know which one they are looking at.
 *
 * `id` is nullable here and nowhere else a published record appears: a file
 * the mirror has no row for is still in force.
 */
export const RecordDetail = z.object({
  record: PublishedRecord.extend({
    id: PublicId.nullable(),
    /** `retired` and `superseded` both read as archived on the page. */
    status: z.enum(["active", "retired", "superseded"]),
  }),
  backing: z.enum(["file", "registry"]),
  /**
   * The commit that published the record, read from the file's history every
   * time. Null when there is no history to read: no repository is bound, or
   * GitHub refused.
   */
  provenance: z
    .object({
      commit: z.string().min(1),
      authorName: z.string(),
      authorLogin: z.string().nullable(),
      committedAt: Instant,
      summary: z.string(),
    })
    .nullable(),
  /**
   * Distinct runs that rendered the record, and distinct runs that cited it.
   * Null when the workspace has no context-use rollup at all, which the page
   * renders as not recorded and never as a zero: a zero reads as every run
   * ignoring the rule.
   */
  effect: z.object({ rendered: Count, cited: Count }).nullable(),
  versions: z.array(
    z.object({
      id: PublicId,
      version: z.number().int().positive(),
      checksum: z.string().min(1),
      isLatest: z.boolean(),
      publishedAt: Instant.nullable(),
    }),
  ),
  /** The proposal whose merge published the active version; null otherwise. */
  proposalId: PublicId.nullable(),
  prUrl: z.string().min(1).nullable(),
});
export type RecordDetail = z.infer<typeof RecordDetail>;

export const SteeringDeliveries = z.object({
  runs: z.array(
    z.object({
      sessionUuid: z.uuid(),
      ts: z.string(),
      harness: z.string(),
      agentKey: z.string(),
      recordsIncluded: Count,
      recordsCut: Count,
      recordsCutForBudget: Count,
      budgetTokens: Count,
      spentTokens: Count,
    }),
  ),
  undelivered: z.array(
    z.object({
      /**
       * The record as the steering manifest named it. Oxagen neither mints nor
       * validates it here, so it is a `…Ref`, not a `PublicId` (INV-11).
       */
      recordRef: z.string(),
      runs: Count,
      lastReason: z.string(),
      lastSeen: z.string(),
    }),
  ),
  scanned: Count,
  truncated: z.boolean(),
});
export type SteeringDeliveries = z.infer<typeof SteeringDeliveries>;

/**
 * The mode `.oxagen/rules/governance.toml` declares on the main repository's
 * production branch, as `get_repository_tree` read it. `absent` is no file,
 * which the Context PR gate reads as `team`; `invalid` is a file naming no
 * mode the gate knows, which refuses every open and merge.
 */
export const DeclaredGovernanceMode = z.enum([
  "solo",
  "team",
  "regulated",
  "absent",
  "invalid",
]);
export type DeclaredGovernanceMode = z.infer<typeof DeclaredGovernanceMode>;

/**
 * What the Steering hub header reads beside the library (roadmap
 * pages/steering.md): the governance mode on the main repository and the
 * proposals waiting for a person.
 *
 * Each half is its own read and fails on its own. `governance` is `unbound`
 * while the workspace binds no main repository and `unread` when a read was
 * refused or failed, with the code it answered; the chip prints that rather
 * than a mode nobody read. `proposalsWaiting` is null when a count failed, so
 * the tab badge prints nothing rather than a zero nobody counted.
 */
export const SteeringHub = z.object({
  governance: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("read"),
      /** `owner/name` of the main repository. */
      repository: z.string().min(1),
      mode: DeclaredGovernanceMode,
    }),
    z.object({ state: z.literal("unbound") }),
    z.object({ state: z.literal("unread"), code: z.string().min(1) }),
  ]),
  /** Proposals not merged and not dismissed: candidates plus open Context PRs. */
  proposalsWaiting: Count.nullable(),
});
export type SteeringHub = z.infer<typeof SteeringHub>;
