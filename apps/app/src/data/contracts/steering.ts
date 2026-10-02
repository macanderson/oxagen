// The Steering page's view models (#2961; ADR-061; MC spec §10), from
// list_records, list_proposals and get_context_pr, and the Memories tab's
// from the workspace memory reads (#4914). A record is in force
// because a Context PR merged it; a proposal steers nothing; the Context PR
// carries the state machine, its checks and what merge will do. Effect
// metrics, retirement and promotion thresholds have no view model: they are
// not in this release.
import { z } from "zod";
import { PublicId } from "./common";
import { Cost } from "./money";

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

/**
 * What a proposal changes: a record of one of the six kinds, or the steering
 * repository's governance mode (#4795). A governance proposal publishes no
 * record.
 */
export const ProposalKind = z.enum([...RECORD_KINDS, "governance"]);
export type ProposalKind = z.infer<typeof ProposalKind>;

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

/**
 * A listed record, with what its line costs (#4572). Only list_records
 * prices a record, so the record page's view model does not carry these.
 */
const ListedRecord = PublishedRecord.extend({
  /** The tokens of the record's line in the signed bundle; null for a record the assembler drops. */
  contextTokens: Count.nullable().optional(),
  /**
   * What those tokens cost the workspace over the last 7 days, an estimate
   * the server priced at the weekly price the tool providers use (ADR-060).
   * Null when the tokens are null or the week has no price.
   */
  weeklyPrice: Cost.nullable().optional(),
});

export const RecordPage = z.object({
  records: z.array(ListedRecord),
  /** Every record in force of the kind asked for, ignoring the page. */
  total: Count,
});
export type RecordPage = z.infer<typeof RecordPage>;

export const Proposal = z.object({
  id: PublicId,
  /** The lineage the record or proposal is about: the file stem under .oxagen/rules/, not an id. */
  lineage: z.string().min(1),
  kind: ProposalKind,
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
  /** A record kind, or governance for a change to the governance mode (#4795). */
  kind: ProposalKind,
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
    /**
     * The promotion ledger's length now and after merge. It is not the
     * steering version: a steering repo's first commit and each sync publish
     * add a version and no ledger entry (#4732).
     */
    bundleVersion: z.object({ current: Count, afterMerge: Count }),
  }),
  merged: z
    .object({
      commit: z.string().min(1),
      at: Instant,
      /** Null for a governance proposal, which appends no promotion event. */
      promotionEventId: PublicId.nullable(),
      /** Null for a governance proposal, which publishes no record. */
      recordId: PublicId.nullable(),
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
  /**
   * The repository sync (ADR-184): the production-branch commit the registry
   * last matched and what was wrong with the record files there. Null before
   * the workspace's first sync.
   */
  sync: z
    .object({
      status: z.enum(["pending", "synced", "problems", "failed"]),
      headSha: z.string().min(1).nullable(),
      syncedAt: Instant.nullable(),
      error: z.string().nullable(),
      findings: z.array(
        z.object({
          level: z.enum(["error", "warning"]),
          path: z.string(),
          lineage: z.string().nullable(),
          message: z.string(),
        }),
      ),
    })
    .nullable(),
});
export type SteeringFreshness = z.infer<typeof SteeringFreshness>;

/**
 * The layout of the workspace's main repository, from `get_steering_layout`
 * (#4765): `steering` when its production branch carries
 * `steering/governance.toml`, `legacy` otherwise, and null while no
 * repository is bound or the read failed. The record page needs it to name
 * the file and branch `open_context_pr` writes, because the two layouts
 * disagree on both.
 */
export const SteeringLayout = z.object({
  layout: z.enum(["steering", "legacy"]).nullable(),
});
export type SteeringLayout = z.infer<typeof SteeringLayout>;

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
 * The mode the main repository's governance file declares on its production
 * branch, as `get_repository_tree` read it: `steering/governance.toml` in a
 * steering repository, `.oxagen/rules/governance.toml` in a legacy one
 * (#4821). `absent` is no file,
 * which the Context PR gate reads as `team`; `invalid` is a file naming no
 * mode the gate knows, which refuses every open and merge.
 */
const DeclaredGovernanceMode = z.enum([
  "solo",
  "team",
  "regulated",
  "absent",
  "invalid",
]);
type DeclaredGovernanceMode = z.infer<typeof DeclaredGovernanceMode>;

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
      /** The governance file the mode was read from. */
      path: z.string().min(1),
      mode: DeclaredGovernanceMode,
    }),
    z.object({ state: z.literal("unbound") }),
    z.object({ state: z.literal("unread"), code: z.string().min(1) }),
  ]),
  /** Proposals not merged and not dismissed: candidates plus open Context PRs. */
  proposalsWaiting: Count.nullable(),
  /**
   * The Proposals segment counts (roadmap pages/steering-proposals.md): every
   * proposal the Candidates list holds, and the Context PRs still open (every
   * proposal less the ones with no pull request, the merged and the
   * dismissed). Null when any count failed, like `proposalsWaiting`.
   */
  segments: z.object({ candidates: Count, prs: Count }).nullable(),
  /**
   * The workspace memories waiting for a person, for the Memories tab's
   * count. Null when the count failed, so the tab prints no figure.
   */
  memoriesWaiting: Count.nullable(),
});
export type SteeringHub = z.infer<typeof SteeringHub>;

/**
 * The eight kinds of steering-record/v1, the kinds a workspace memory and a
 * memory PR's record carry. The registry's six context-record kinds are
 * `RecordKind` above.
 */
const STEERING_RECORD_KINDS = [
  "business-rule",
  "code-rule",
  "constraint",
  "procedure",
  "skill",
  "fact",
  "preference",
  "memory",
] as const;
export const SteeringRecordKind = z.enum(STEERING_RECORD_KINDS);
export type SteeringRecordKind = z.infer<typeof SteeringRecordKind>;

/** Where a workspace memory is in its life (ADR-248), in the order the State filter lists them. */
export const WORKSPACE_MEMORY_STATES = [
  "waiting",
  "in_pr",
  "promoted",
  "dismissed",
  "retired",
] as const;
export const WorkspaceMemoryState = z.enum(WORKSPACE_MEMORY_STATES);
export type WorkspaceMemoryState = z.infer<typeof WorkspaceMemoryState>;

/** The harnesses whose memory stores Oxagen collects from an enrolled host. */
export const MEMORY_HARNESSES = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
  "claude-desktop",
] as const;
export const MemoryHarness = z.enum(MEMORY_HARNESSES);
export type MemoryHarness = z.infer<typeof MemoryHarness>;

/** How a memory reached Oxagen: an agent's lesson, a pull request, the local gateway, or an import. */
const MemoryCapture = z.enum([
  "remember",
  "pull_request",
  "local_gateway",
  "import",
]);

const MemoryPrStatus = z.enum(["open", "merged", "closed"]);

/**
 * One workspace memory (memory-collection spec, Memories tab; ADR-248), from
 * `list_workspace_memories`: what an agent wrote in its harness's own memory
 * store, or through `remember_lesson`. It steers only the agent that wrote
 * it. `uses` counts the distinct runs that used it, and `useSignal` is false
 * for a source that reports no use, so a zero reads as "No signal".
 */
export const WorkspaceMemory = z.object({
  id: PublicId,
  /** The memory file's frontmatter `name`, when it has one. */
  label: z.string().nullable(),
  /** The memory file's frontmatter `description`, when it has one. */
  summary: z.string().nullable(),
  statement: z.string(),
  state: WorkspaceMemoryState,
  capture: MemoryCapture,
  /** The harness whose store holds it; null for a memory no harness holds. */
  harness: MemoryHarness.nullable(),
  /** The agent that wrote it, by its key (`org_ns.ws_ns.slug`); null when Oxagen could not tell. */
  agent: z.string().nullable(),
  /** `<harness>:<path>` for a harness memory file, a pull request URL, or null. */
  source: z.string().nullable(),
  repos: z.array(z.string()).nullable(),
  /** A Claude Code memory file's type, such as `feedback`. */
  memoryType: z.string().nullable(),
  kind: SteeringRecordKind,
  uses: Count,
  useSignal: z.boolean(),
  lastUsedAt: Instant.nullable(),
  createdAt: Instant,
  /** The steering record that carries it, once promoted. */
  promotedLineage: z.string().nullable(),
  /** The memory PR that last cited it. */
  memoryPr: z
    .object({
      number: z.number().int().positive(),
      url: z.string().min(1),
      status: MemoryPrStatus,
    })
    .nullable(),
});
export type WorkspaceMemory = z.infer<typeof WorkspaceMemory>;

/**
 * One page of the Memories tab. Memories that say the same thing share a
 * group, and the highest ranked one speaks for it. The page counts groups.
 * `waiting` counts the workspace's waiting memories whatever the filters.
 */
export const WorkspaceMemoryPage = z.object({
  groups: z.array(
    z.object({
      memory: WorkspaceMemory,
      members: z.array(WorkspaceMemory).min(1),
      uses: Count,
      lastUsedAt: Instant.nullable(),
    }),
  ),
  totalGroups: Count,
  totalMemories: Count,
  /** True when more memories matched than the list groups. */
  truncated: z.boolean(),
  waiting: Count,
});
export type WorkspaceMemoryPage = z.infer<typeof WorkspaceMemoryPage>;

/** What one Memories read asks for; null leaves that filter off. */
export type WorkspaceMemoryQuery = {
  states: readonly WorkspaceMemoryState[];
  harness: MemoryHarness | null;
  /** An agent key. */
  agent: string | null;
  /** `<host>/<owner>/<name>`, such as `github.com/acme/api`. */
  repository: string | null;
  type: string | null;
  limit: number;
  offset: number;
};

/** A memory PR as one memory or the review card reads it. */
const MemoryPullRequest = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  status: MemoryPrStatus,
  openedAt: Instant,
  settledAt: Instant.nullable(),
});

/**
 * One memory in full, for the Memories tab's drawer, from
 * `get_workspace_memory`: where it came from, the runs that used it (newest
 * first, at most 100 of `usesTotal`), and the memory PR that last cited it.
 */
export const WorkspaceMemoryDetail = z.object({
  memory: WorkspaceMemory.extend({
    /** The run that wrote it, or null for a memory with no run. */
    run: z.string().nullable(),
    /** `frame:<run>/<seq>` references, or URLs for a memory with no run. */
    evidence: z.array(z.string()),
    retiredAt: Instant.nullable(),
    retiredReason: z.enum(["deleted", "unused"]).nullable(),
  }),
  uses: z.array(
    z.object({
      /** The run, or null for a use the harness counted with no run. */
      run: z.string().nullable(),
      signal: z.enum(["read", "harness_count", "citation"]),
      count: z.number().int().positive(),
      usedAt: Instant,
    }),
  ),
  usesTotal: Count,
  memoryPr: MemoryPullRequest.nullable(),
});
export type WorkspaceMemoryDetail = z.infer<typeof WorkspaceMemoryDetail>;

/**
 * The records one memory PR proposes or archives, for the memory PR review
 * card, from `list_memory_pr_records`. `branchRead` is false for a settled
 * PR or a branch that could not be read; each record then takes its title and
 * summary from its first memory.
 */
export const MemoryPrRecords = z.object({
  pullRequest: MemoryPullRequest,
  branchRead: z.boolean(),
  records: z.array(
    z.object({
      action: z.enum(["propose", "retire"]),
      path: z.string().min(1),
      lineage: z.string().min(1),
      kind: SteeringRecordKind,
      title: z.string(),
      summary: z.string(),
      /** The memories the record cites, in the order the PR cites them. A retirement cites none. */
      memories: z.array(
        z.object({
          id: PublicId,
          statement: z.string(),
          agent: z.string().nullable(),
          run: z.string().nullable(),
          evidence: z.array(z.string()),
          state: WorkspaceMemoryState,
        }),
      ),
      /** The commit on the open PR's branch that removed the record, or null. */
      dropped: z.object({ commitSha: z.string().min(1) }).nullable(),
    }),
  ),
});
export type MemoryPrRecords = z.infer<typeof MemoryPrRecords>;

/**
 * The Library's Memory shelf (roadmap pages/steering-memory.md), from
 * `list_memories`: the `:AgentMemory` nodes the workspace holds, newest first.
 *
 * `memoryClass` is the class the node records (OBSERVATION, RULE or FACT),
 * printed as recorded rather than mapped onto the design's class names. The
 * node carries no force, no scope, no run or frame, and no recall counter, so
 * the view model has no field for any of them and the shelf prints each as
 * not recorded. Neither of its two identifiers is a public id Oxagen mints
 * in the `prefix_value` form, so both are `…Ref` (INV-11): `ref` is the node
 * id `update_memory` takes, and `publicRef` is the identifier a reader sees.
 */
export const MemoryItem = z.object({
  ref: z.string().min(1),
  publicRef: z.string().min(1),
  body: z.string(),
  memoryClass: z.enum(["OBSERVATION", "RULE", "FACT"]),
  /** The provenance label the writer set: user, feature, fix, and so on. */
  source: z.string(),
  /** Who wrote it: a person, an agent or the system. */
  writtenBy: z.enum(["person", "agent", "system"]),
  /** When the node was written, which is when it came into force. */
  createdAt: z.string().min(1),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

export const MemoryPage = z.object({
  memories: z.array(MemoryItem),
  /** Every active memory in the workspace, ignoring the page. */
  total: Count,
});
export type MemoryPage = z.infer<typeof MemoryPage>;

/**
 * The `.oxagen/` tree on the main repository's production branch, as
 * `get_repository_tree` read it from GitHub for the Records shelf's On disk
 * panel. `unbound` is a workspace with no main repository.
 */
export const OxagenTree = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("read"),
    /** `owner/name`. */
    repository: z.string().min(1),
    branch: z.string().min(1),
    /** The branch's head commit; null when the branch is gone. */
    head: z.string().min(1).nullable(),
    /**
     * The directory the panel lists: `steering` in a steering repository,
     * `.oxagen` in a legacy one.
     */
    root: z.enum(["steering", ".oxagen"]),
    /** Every path under `root`, relative to it, sorted. */
    files: z.array(z.string().min(1)),
    /** The governance file `mode` was read from. */
    governancePath: z.string().min(1),
    mode: DeclaredGovernanceMode,
  }),
  z.object({ state: z.literal("unbound") }),
]);
export type OxagenTree = z.infer<typeof OxagenTree>;
