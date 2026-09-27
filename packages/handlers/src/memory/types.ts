// The shapes the memory pipeline passes between its steps (ADR-206).
//
// capture.ts turns a sealed run's frames into drafts, store.ts writes and
// reads the five memory tables, curate.ts and settle.ts decide what the next
// memory PR holds, recall.ts ranks what reaches a request, and runner.ts wires
// them to the steering repo. Every step but the store and the runner is pure.
import type { z } from "zod";
import type { GovernanceSettings } from "@oxagen/oxagen/steering-repo/governance";
import type {
  ProvenanceMemory,
  RecordKind,
} from "@oxagen/oxagen/steering-repo/record";
import type { reflectionOutcomeSchema } from "@oxagen/oxagen/steering-repo/reflection";

/** The workspace a memory belongs to. Every store call runs inside it. */
export interface MemoryScope {
  orgId: string;
  workspaceId: string;
}

/** How a memory reached Oxagen (memory/v1 `capture`). */
export type MemoryCapture = "remember" | "pull_request" | "local_gateway";

/** A memory ready to store. The store gives it an id. */
export interface MemoryDraft {
  /** The agent's lineage as the run recorded it, or null when Oxagen could not tell. */
  agentLineage: string | null;
  /** The run's public id (`arun_…` or `tse_…`), or null for a memory with no run. */
  runPublicId: string | null;
  capture: MemoryCapture;
  statement: string;
  /** `statementHash(statement)`: the key a rejection matches. */
  statementHash: string;
  kind: RecordKind;
  repos: string[] | null;
  appliesTo: string[] | null;
  tools: string[] | null;
  /** `frame:<run>/<seq>` references, or a URL for a memory with no run. */
  evidence: string[];
  /** Where a pull_request or local_gateway memory came from. */
  source: string | null;
  /** The run, or the capture and source, plus the statement hash. */
  dedupeKey: string;
}

/** A stored memory. `memoryPrId` is null while it waits for the curator. */
export interface StoredMemory extends MemoryDraft {
  /** The row's uuid. Memory PR records cite memories by it. */
  id: string;
  publicId: string;
  reflectionId: string | null;
  memoryPrId: string | null;
  createdAt: Date;
}

/** How a run ended, in the run record's words (reflection/v1 `outcome`). */
export type ReflectionOutcome = z.output<typeof reflectionOutcomeSchema>;

/** One reflection/v1 lesson as a reflection row keeps it. */
export interface ReflectionLesson {
  statement: string;
  kind: RecordKind;
  repos?: string[];
  applies_to?: string[];
  tools?: string[];
  evidence: string[];
}

/** A reflection ready to store. Its lessons are also stored as memories. */
export interface ReflectionDraft {
  runPublicId: string;
  agentLineage: string | null;
  /** `agent` when the agent called record_reflection, `digest` when run.reflect wrote it. */
  source: "agent" | "digest";
  outcome: ReflectionOutcome;
  summary: string;
  /** Tool grades are keyed `<server>__<tool>`. They go to the server owner and never steer. */
  grades: { work: number; tools: Record<string, number> };
  lessons: ReflectionLesson[];
  toolFeedback: Array<{ tool: string; problem: string }>;
}

/** What `run.reflect` found in one sealed run. */
export interface RunCapture {
  memories: MemoryDraft[];
  /** The agent's own reflection, or null when the run holds no valid call. */
  reflection: ReflectionDraft | null;
}

/** The lessons of one stored reflection, for the contradiction check. */
export interface RecentReflection {
  createdAt: Date;
  lessons: Array<{ statement: string }>;
}

/** A steering record read from the steering repo's default branch. */
export interface ActiveRecord {
  path: string;
  lineage: string;
  kind: RecordKind;
  status: "active" | "archived";
  /** The record's body, as `recordStatement` gives it. */
  statement: string;
  /** The record's `repos`, `applies_to`, and `tools`, which recall scopes by. */
  repos: string[] | null;
  appliesTo: string[] | null;
  tools: string[] | null;
  /** The whole file, so a retirement can rewrite its status. */
  text: string;
}

/** A `memory_recalls` row. */
export interface RecallStamp {
  lineage: string;
  recallCount: number;
  lastRecalledAt: Date;
  /** When a person last decided on the record. */
  reviewedAt: Date;
}

/** A `memory_rejections` row. */
export interface Rejection {
  statementHash: string;
  rejectedAt: Date;
}

/**
 * One record a memory PR proposes or retires, as `memory_prs.records` keeps
 * it. A retirement cites no memories, so both lists are empty.
 */
export interface MemoryPrRecord {
  action: "propose" | "retire";
  lineage: string;
  path: string;
  kind: RecordKind;
  memoryIds: string[];
  statementHashes: string[];
}

/** A `memory_prs` row whose PR is still open. */
export interface OpenMemoryPr {
  id: string;
  provider: string;
  repository: string;
  branch: string;
  number: number;
  url: string;
  records: MemoryPrRecord[];
  openedAt: Date;
}

/** The PR as the provider reports it when the curator settles. */
export interface PrState {
  open: boolean;
  merged: boolean;
  mergedAt: Date | null;
}

/** What settling one decided memory PR writes, in one transaction. */
export interface PrSettlement {
  prId: string;
  status: "merged" | "closed";
  settledAt: Date;
  /** Proposed records that merged: each gets a recall row stamped at the merge. */
  mergedLineages: string[];
  /** Records whose retirement was decided: the stale clock and review time reset. */
  reviewedLineages: string[];
  /** The hash of each statement a record that did not merge cited. */
  rejectedHashes: string[];
  /** Every memory the PR cited. The store deletes them. */
  purgeMemoryIds: string[];
}

/** The fields a new memory record file is rendered from. */
export interface MemoryRecordDraft {
  lineage: string;
  /** code-rule, business-rule, and fact keep their kind. Any other kind is memory. */
  kind: RecordKind;
  /** The representative memory's statement, the record's body. */
  statement: string;
  repos: string[] | null;
  appliesTo: string[] | null;
  tools: string[] | null;
  /** Where the record came from, such as the first cited run's page. */
  uri: string;
  /** Each cited memory's agent, run, statement, and evidence, nulls kept. */
  memories: ProvenanceMemory[];
}

/** A record the next memory PR adds. */
export interface PlannedRecord {
  path: string;
  draft: MemoryRecordDraft;
  memoryIds: string[];
  statementHashes: string[];
}

/** A record the next memory PR archives. */
export interface PlannedRetirement {
  path: string;
  lineage: string;
  kind: RecordKind;
  reason: "contradicted" | "stale";
  /** The record's current text. The runner rewrites its status. */
  text: string;
}

/** Everything the curator reads to plan one workspace's memory PR. */
export interface CurateInput {
  now: Date;
  governance: Pick<GovernanceSettings, "batch_size" | "retire_after_days">;
  /** Memories with no memory PR, oldest first. */
  waiting: StoredMemory[];
  /** Every record under steering/ at the default branch. */
  records: ActiveRecord[];
  /** Records in memory PRs that are still open after settling. */
  pending: MemoryPrRecord[];
  rejections: Rejection[];
  recalls: RecallStamp[];
  /** Reflections from the last `retire_after_days`. */
  reflections: RecentReflection[];
  /** The page the provenance `uri` names for a run, such as the Run page URL. */
  runUri: (runPublicId: string) => string;
}

/** Why a waiting memory leaves the queue without a record. */
export type DropReason = "said" | "expired";

/** What the curator decided for one workspace. */
export interface CuratePlan {
  /** Memories to delete: an active record already says them, or they waited too long. */
  drops: Array<{ memoryId: string; reason: DropReason }>;
  /** Memories left waiting: a rejected statement with no new evidence, or one an open PR already proposes. */
  held: string[];
  /** Memories left for a later day because the batch or the PR's file limit is full. */
  deferred: string[];
  records: PlannedRecord[];
  retirements: PlannedRetirement[];
  /** Lineages of records to archive that did not fit in the PR. A later pass proposes them again. */
  queuedRetirements: string[];
  /** Memory records with no recall row. The store stamps one now, which starts their stale clock. */
  stampRecalls: string[];
}

/** One request recall answers. */
export interface RecallRequest {
  now: Date;
  /** The requesting agent's lineage, or null when Oxagen could not tell. */
  agent: string | null;
  /** True for Oxagen's in-app agent, which receives no workspace memories. */
  inApp: boolean;
  /** The code repository the run works in, as <host>/<owner>/<name>. */
  repository: string | null;
  /** The tools on the run's toolbelt, as <server>__<tool>. */
  tools: string[];
  /** The paths the request names. */
  paths: string[];
  /** The request's words, which relevance is measured against. */
  text: string;
  recallUnreviewed: GovernanceSettings["recall_unreviewed"];
  /** Days for a candidate's weight to halve. 30 until governance/v1 carries the field. */
  halfLifeDays?: number;
}

/** A merged record or an unreviewed memory that recall may answer. */
export interface RecallCandidate {
  /** A record's lineage, or a memory's public id. */
  id: string;
  source: "record" | "memory";
  /** A memory's agent. A record has none. */
  agent: string | null;
  statement: string;
  repos: string[] | null;
  appliesTo: string[] | null;
  tools: string[] | null;
  /** A record's merge time, or a memory's capture time. Age runs from it. */
  since: Date;
}

/** One memory recall answers. */
export interface RecallItem {
  id: string;
  source: "record" | "memory";
  statement: string;
  score: number;
  tokens: number;
}

/** The reads and writes of the five memory tables. store.ts is the Postgres implementation. */
export interface MemoryStore {
  /**
   * Every workspace the daily curator has work in: waiting memories, an open
   * memory PR, or a recall row for the retirement check. Reads across tenants.
   */
  listCurateWorkspaces(): Promise<MemoryScope[]>;
  /**
   * Store the run's reflection and its lesson memories in one transaction,
   * the lessons carrying the reflection's id. Returns its id, or null when the
   * run already has one, and then writes nothing.
   */
  insertReflection(
    scope: MemoryScope,
    draft: ReflectionDraft,
    lessons?: MemoryDraft[],
  ): Promise<string | null>;
  /** Does the run already have a reflection? */
  hasReflection(scope: MemoryScope, runPublicId: string): Promise<boolean>;
  /** Store memories, skipping any whose dedupe key exists. Returns the count written. */
  insertMemories(
    scope: MemoryScope,
    drafts: MemoryDraft[],
    reflectionId?: string | null,
  ): Promise<number>;
  countWaiting(scope: MemoryScope): Promise<number>;
  /** Waiting memories, oldest first. */
  listWaiting(scope: MemoryScope): Promise<StoredMemory[]>;
  deleteMemories(scope: MemoryScope, ids: string[]): Promise<number>;
  listOpenPrs(scope: MemoryScope): Promise<OpenMemoryPr[]>;
  /**
   * Has the workspace opened a memory PR from this branch, whatever became of
   * it? The curator opens one PR a day, and the branch names the day.
   */
  openedPrFrom(scope: MemoryScope, branch: string): Promise<boolean>;
  /** Record an opened memory PR and mark the memories it cites, in one transaction. */
  insertMemoryPr(
    scope: MemoryScope,
    pr: Omit<OpenMemoryPr, "id" | "openedAt">,
  ): Promise<string>;
  /** Apply a settlement, in one transaction. */
  settlePr(scope: MemoryScope, settlement: PrSettlement): Promise<void>;
  listRejections(scope: MemoryScope): Promise<Rejection[]>;
  listRecalls(scope: MemoryScope): Promise<RecallStamp[]>;
  /** Set each lineage's recall and review time to `at`, creating the row when missing. */
  stampRecalls(
    scope: MemoryScope,
    lineages: string[],
    at: Date,
  ): Promise<void>;
  /** Count one recall of each lineage at `at`, creating the row when missing. */
  bumpRecalls(scope: MemoryScope, lineages: string[], at: Date): Promise<void>;
  listReflectionsSince(
    scope: MemoryScope,
    since: Date,
  ): Promise<RecentReflection[]>;
}
