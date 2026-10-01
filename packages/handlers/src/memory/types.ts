// The shapes the memory pipeline passes between its steps (ADR-206, ADR-245).
//
// capture.ts turns a sealed run's frames into drafts, store.ts writes and
// reads the six memory tables, curate.ts and settle.ts decide what the next
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
export type MemoryCapture =
  | "remember"
  | "pull_request"
  | "local_gateway"
  | "import";

/**
 * Where a memory is in its life (ADR-245). A memory keeps its row in every
 * state, and with it its uses.
 *
 * - `waiting`: collected, and in no open memory PR.
 * - `in_pr`: an open memory PR cites it.
 * - `promoted`: a steering record carries it, and it keeps counting uses.
 * - `dismissed`: a person dismissed it.
 * - `retired`: its file is gone, or no run used it for `retire_after_days`.
 */
export type MemoryState =
  | "waiting"
  | "in_pr"
  | "promoted"
  | "dismissed"
  | "retired";

/** Why a memory retired. */
export type RetiredReason = "deleted" | "unused";

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
  /** A memory file's frontmatter `name`, when it has one. */
  label?: string | null;
  /** A memory file's frontmatter `description`, when it has one. */
  summary?: string | null;
  /** A memory file's frontmatter `metadata.type`, such as `feedback`. */
  memoryType?: string | null;
}

/** A stored memory. */
export interface StoredMemory extends MemoryDraft {
  /** The row's uuid. Memory PR records cite memories by it. */
  id: string;
  publicId: string;
  reflectionId: string | null;
  /** The memory PR that last cited it, or null when none has. */
  memoryPrId: string | null;
  state: MemoryState;
  /** Distinct runs that used it, plus uses a harness counted with no run. */
  useCount: number;
  /** The newest use, or null when no run used it. */
  lastUsedAt: Date | null;
  /** The steering record that carries it, once promoted. */
  promotedLineage: string | null;
  createdAt: Date;
}

/** How a run used a memory (`agent.memory_uses.signal`). */
export type MemoryUseSignal = "read" | "harness_count" | "citation";

/**
 * One use of the memory a source holds, as a host reports it. The store
 * finds the memory by its capture and source.
 */
export interface MemoryUseDraft {
  capture: MemoryCapture;
  source: string;
  /** The run's public id. Null only for a harness's own count. */
  runPublicId: string | null;
  signal: MemoryUseSignal;
  /** Reads in the run, or the harness's count. At least 1. */
  count: number;
  usedAt: Date;
}

/**
 * What one full scan of a memory folder found. Each waiting or promoted
 * memory of the agent whose source starts with `prefix` and is not in
 * `seen` retires.
 */
export interface MemoryScanReport {
  capture: MemoryCapture;
  /** `<harness>:<folder><separator>`. */
  prefix: string;
  /** The source of every memory file the scan found. */
  seen: string[];
  /** The host's agent. Only its memories retire. */
  agentLineage: string | null;
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
  /** The memories of each record that merged. They become promoted and link to it. */
  promoted: Array<{ lineage: string; memoryIds: string[] }>;
  /** The memories of each record that did not merge. They wait again. */
  returnedMemoryIds: string[];
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
  /** Waiting memories, oldest first. The plan ranks them by use. */
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

/** What the curator decided for one workspace. */
export interface CuratePlan {
  /**
   * Memories an active steering record already says. Each links to that
   * record and becomes promoted, since the record already carries it.
   */
  said: Array<{ memoryId: string; lineage: string }>;
  /** Memories left waiting: a rejected statement with no new evidence, or one an open PR already proposes. */
  held: string[];
  /** Memories left waiting because no run used them yet. Only a used memory enters the batch. */
  unused: string[];
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
  /** True for Oxagen's in-app agent, which receives no workspace memories. */
  inApp: boolean;
  /**
   * The digests of the code repository the request runs in, as a Tacho host
   * computes them from its remote (`remoteDigests` in lib/remote-digests).
   * The host sends digests, so the repository's owner and name stay on the
   * machine. Empty when the repository is unknown.
   */
  repositoryDigests: readonly string[];
  /** The tools on the run's toolbelt, as <server>__<tool>. */
  tools: string[];
  /** The paths the request names. */
  paths: string[];
  /** The request's words, which relevance is measured against. */
  text: string;
  /** Days for a candidate's weight to halve. 30 until governance/v1 carries the field. */
  halfLifeDays?: number;
}

/**
 * A merged memory record that recall may answer. Recall answers steering
 * records only: a memory that waits for review is never a candidate (ADR-238).
 */
export interface RecallCandidate {
  /** The record's lineage. */
  id: string;
  statement: string;
  repos: string[] | null;
  appliesTo: string[] | null;
  tools: string[] | null;
  /** The record's last review, such as its merge. Age runs from it. */
  since: Date;
}

/** One record recall answers. */
export interface RecallItem {
  /** The record's lineage. */
  id: string;
  /** Always `record`. The contract's answer keeps the field (ADR-238). */
  source: "record";
  statement: string;
  score: number;
  tokens: number;
}

/** The reads and writes of the six memory tables. store.ts is the Postgres implementation. */
export interface MemoryStore {
  /**
   * Every workspace the daily curator has work in: waiting memories, an open
   * memory PR, or a recall row for the retirement check. Reads across
   * tenants.
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
  /**
   * Store a memory as the one waiting memory of its capture and source
   * (ADR-238, ADR-245). Tacho's memory upload calls it for each
   * `local_gateway` memory, whose source is `<harness>:<path>`, so a memory
   * file has one waiting row and each edit replaces its text.
   *
   * A waiting row from the same capture and source takes the draft's
   * statement, hash, dedupe key, and the rest of its content in place, and
   * keeps its id, its creation time, and its uses. A row an open memory PR
   * cites, a promoted row, and a dismissed row keep their text, and the draft
   * becomes a new waiting row. When the file goes back to text another row of
   * the source holds, that row holds the file's text again: the waiting row
   * retires, and a row retired because its file was gone comes back. Returns
   * true when it inserted or brought back a row or changed its text, and false
   * when the workspace already holds the statement from that source.
   */
  replaceSourceMemory(scope: MemoryScope, draft: MemoryDraft): Promise<boolean>;
  countWaiting(scope: MemoryScope): Promise<number>;
  /** Waiting memories, oldest first. */
  listWaiting(scope: MemoryScope): Promise<StoredMemory[]>;
  /**
   * Store uses against the memory each source holds now: its waiting
   * memory, else its newest memory that has not retired, else its newest
   * memory. A run's uses of one memory share one row per signal, so a run
   * counts once however often it reads the file. The memory's `use_count`
   * and `last_used_at` are recomputed from its uses in the same transaction,
   * and a retired memory a run used comes back. Returns the uses stored and
   * those whose source holds no memory.
   */
  recordUses(
    scope: MemoryScope,
    uses: MemoryUseDraft[],
  ): Promise<{ recorded: number; unknown: number }>;
  /**
   * Retire each waiting or promoted memory a full scan no longer found, as
   * `deleted`. Returns the count retired.
   */
  retireMissingSources(
    scope: MemoryScope,
    scan: MemoryScanReport,
    at: Date,
  ): Promise<number>;
  /**
   * Retire each waiting or promoted memory whose newest use, or its capture
   * when no run used it, came before `before`, as `unused`. Returns the
   * count retired.
   */
  retireUnused(scope: MemoryScope, before: Date, at: Date): Promise<number>;
  /**
   * Link waiting memories to the steering record that already says them.
   * Each becomes promoted. Returns the count linked.
   */
  linkMemories(
    scope: MemoryScope,
    links: Array<{ memoryId: string; lineage: string }>,
  ): Promise<number>;
  listOpenPrs(scope: MemoryScope): Promise<OpenMemoryPr[]>;
  /**
   * Has the workspace opened a memory PR from this branch, whatever became of
   * it? The curator opens one PR a day, and the branch names the day.
   */
  openedPrFrom(scope: MemoryScope, branch: string): Promise<boolean>;
  /** Record an opened memory PR and move the memories it cites to `in_pr`, in one transaction. */
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
