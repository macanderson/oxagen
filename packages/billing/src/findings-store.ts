/**
 * findings-store.ts — the reads and writes around the pure detectors
 * (./findings/): a workspace's run rows and root sessions from Postgres, its
 * tool-call frames and model-call frames from ClickHouse, and the
 * `cost.findings` and `cost.finding_claims` rows (Mission Control spec
 * §12.8; ADR-062, ADR-208).
 *
 * The findings job runs on the system connection with explicit org and
 * workspace predicates, outside a tenant scope. Two reads run in the
 * workspace's tenant scope instead, so they read what the code that shares
 * their rows reads: the weekly standing context price, as the tool and
 * steering pages do, and the taken instruction lineages, as the proposal
 * opener does. Handlers read the rows through withTenantDb in their own
 * modules.
 */
import { schema, withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  readGroupModelCallFrames,
  readModelCallFrames,
  readTachoFileChanges,
  readTachoToolCallObservations,
  type FileChangeRow,
  type FrameRunRef,
  type ModelCallFrameRow,
  type ToolCallObservationRow,
} from "@oxagen/telemetry";
import {
  and,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";
import { FRAME_TOKEN_CLASSES, type FrameTokenClass } from "./class-cost";
import {
  divideHalfEven,
  priceFrame,
  type ModelCallFrame,
  type RunTotalsRecord,
} from "./cost-rollup";
import { inAppRunTotal, runTotalsRowToRecord } from "./cost-rollup-store";
import {
  type ClaimRow,
  countClaims,
  detectFindings,
  DETECTORS,
  FINDINGS_WINDOW_DAYS,
  instructionLineage,
  instructionProposals,
  microsOf,
  replayClaims,
  resultsToCheck,
  runsWithRepeats,
  runsWithRetries,
  type DetectInput,
  type DetectReads,
  type FindingClaim,
  type FindingDraft,
  type FrameClassPrice,
  type FrameClassPrices,
  type FrameContextPart,
  type FrameCoverage,
  type PricedRequestFrame,
  type PromptRead,
  type ResultUseRead,
  type RunCompaction,
  type RunFirstPrompt,
  type ToolCallObservation,
  type UnproductiveSpend,
} from "./findings";
import { openSpendProposals } from "./findings/open-proposals";
import type { SpendProposalInput } from "./findings/proposal-opener";
import { RECURRING_RUNS_MIN, runsByJob } from "./findings/recurring-runs";
import { readRunPrompts } from "./findings-prompts";
import { readResultUse } from "./findings-result-use";
import {
  readCompactions,
  readFileChanges,
  readFirstPrompts,
  readOutcomes,
  readRunRefs,
} from "./findings-run-facts";
import {
  indexPriceBookByClass,
  loadPriceBookSlice,
  resolvePriceEntryFromClassBook,
  type PriceBook,
  type PriceBookSlice,
  type PriceTokenClass,
} from "./price-book";
import { logger } from "./logger";
import type { OutcomeRow } from "./run-pr-outcomes";
import type { WeeklyContextPrice } from "./standing-context-price";
import { readWeeklyContextPrice } from "./standing-context-price-store";

const totals = schema.runTotals;
const sessions = schema.tachoSessions;
const findings = schema.findings;
const claims = schema.findingClaims;
const records = schema.steeringRecords;
const proposals = schema.steeringProposals;

/** Tool calls one pass reads, newest first; past this the tool-call window starts at the oldest call read. */
export const TOOL_CALL_READ_MAX = 200_000;
/**
 * Model-call frame reads one pass runs. A read is one ClickHouse query: one
 * run's frames, or the frames of a recurring group's runs (#5168). Up to
 * `FRAME_GROUP_READS_RESERVE` of them go to recurring groups. The rest go to
 * single runs, most repeats first, then the dearest. A run no read covers has
 * no frames, and `frameCoverage.capped` counts it (ADR-208, ADR-210).
 */
export const FRAME_READS_MAX = 200;
/**
 * The reads in `FRAME_READS_MAX` kept for recurring groups (#5168, ADR-210).
 * A group is a job whose first prompt started `RECURRING_RUNS_MIN` or more
 * runs in the window, grouped as recurring runs (detector 7) groups them. Each
 * group read takes one place, however many runs it covers, so a scheduled job
 * of 2,500 runs costs one query. A place no group needs goes back to the
 * single runs.
 */
export const FRAME_GROUP_READS_RESERVE = 50;
/**
 * Sessions one group read names at most. ClickHouse takes query parameters
 * in the request URL and refuses a URL over 1 MiB (`http_max_uri_size`). A
 * group read names each run's root and each of its sessions, about 45 bytes
 * each once encoded, so 5,000 sessions keep the URL under half that limit. A
 * group with more sessions is read in the fewest reads that each fit, and
 * each read takes a place.
 */
export const FRAME_GROUP_READ_SESSIONS = 5_000;
/**
 * Group reads the store may refuse in one frame read before the read stops
 * asking for groups (#5462). A refused group's runs count as capped. Every
 * refusal counts toward the process-wide ClickHouse circuit breaker, which
 * opens after 5 failures in a row by default
 * (`CIRCUIT_BREAKER_FAILURE_THRESHOLD`). An open breaker refuses every read
 * the pass has left, the single-run reads too, and that fails the pass. So
 * the read skips the groups left after 2 refusals and counts their runs as
 * capped as well.
 */
export const FRAME_GROUP_READ_REFUSALS_MAX = 2;
/**
 * Model-call frames one pass holds across every run it reads (#4506). The
 * plan sizes its group reads to fit it, by each run's model calls in the
 * rollup. A run whose frames would pass it is not read, and
 * `frameCoverage.capped` counts it with the runs no read covers.
 */
export const FRAME_READ_MAX_FRAMES = 200_000;
/** File-change frames one pass reads, newest first. */
export const FILE_CHANGE_READ_MAX = 200_000;
/** Single-run frame reads one pass runs at once. A group read runs alone (#5462). */
const FRAME_READ_CONCURRENCY = 8;
/** Claim rows one insert statement carries. */
const CLAIM_INSERT_CHUNK = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

type FindingsScope = { orgId: string; workspaceId: string };

/** One run whose model-call frames a pass reads. */
export interface FrameRead {
  /** The run's public id. */
  runId: string;
  ref: FrameRunRef;
  /**
   * The group read that covers the run (#5168). Wrapped runs side by side
   * with one group number are read in one query. Absent on a run read alone.
   */
  group?: number;
  /**
   * The job key of the recurring group the run's group read covers: the key
   * recurring runs (detector 7) groups by. A refused group read names it in
   * its warning (#5462). Absent on a run read alone.
   */
  job?: string;
}

interface FindingsPassDeps {
  now: () => Date;
  readRuns: (
    scope: FindingsScope,
    window: { start: Date; end: Date },
  ) => Promise<RunTotalsRecord[]>;
  /** Root session uuid → the run's public id, for sessions that started in the window. */
  readRootSessions: (
    scope: FindingsScope,
    start: Date,
  ) => Promise<Map<string, string>>;
  readToolCalls: (args: {
    orgId: string;
    workspaceId: string;
    from: Date;
    to: Date;
    limit: number;
  }) => Promise<ToolCallObservationRow[]>;
  /**
   * The window's `oxagen:file_changed` frames, newest first, at most
   * `limit`; absent, the pass reads none and retry loops find nothing.
   */
  readFileChangeRows?: (args: {
    orgId: string;
    workspaceId: string;
    from: Date;
    to: Date;
    limit: number;
  }) => Promise<FileChangeRow[]>;
  /**
   * Each named run's priced model-call frames in time order, by run public
   * id. A `noModel` frame among them goes to the request view alone (#4506).
   */
  readFrames: (
    scope: FindingsScope,
    runs: readonly FrameRead[],
  ) => Promise<Map<string, PricedRequestFrame[]>>;
  /** Per fingerprint, the latest decision on it. */
  readDecisions: (scope: FindingsScope) => Promise<Map<string, Date>>;
  /**
   * The window's operator prompts for the named runs, and the frames that
   * price them (detector 6); absent, the pass reads none.
   */
  readPrompts?: (
    scope: FindingsScope,
    window: { start: Date; end: Date },
    runIdBySession: ReadonlyMap<string, string>,
    runIds: ReadonlySet<string>,
  ) => Promise<PromptRead | undefined>;
  /**
   * Opens the steering record proposals the pass's repeated instructions and
   * finding drafts support; absent, the pass opens none.
   */
  openProposals?: (
    scope: FindingsScope,
    input: SpendProposalInput,
  ) => Promise<void>;
  /**
   * The repeated instruction lineages that already have a steering record or
   * a proposal, in lower case. The opener refuses each of them, so the pass
   * skips them before it caps its proposals (#4579). Absent, the pass skips
   * none.
   */
  readTakenLineages?: (scope: FindingsScope) => Promise<ReadonlySet<string>>;
  /**
   * Each run's frame source, by run public id. Without it, a wrapped run's
   * source is its root and the chains its tool calls name, and a ledger run
   * has none.
   */
  readRunRefs?: (
    scope: FindingsScope,
    runs: readonly RunTotalsRecord[],
    runIdBySession: ReadonlyMap<string, string>,
  ) => Promise<Map<string, FrameRunRef>>;
  /** Each wrapped run's first prompt, by run public id; `rootByRun` maps a run to its root session. */
  readFirstPrompts?: (
    scope: FindingsScope,
    rootByRun: ReadonlyMap<string, string>,
    from: Date,
  ) => Promise<Map<string, RunFirstPrompt>>;
  /** Whether each wrapped run changed a file, by run public id. */
  readFileChanges?: (
    scope: FindingsScope,
    rootByRun: ReadonlyMap<string, string>,
  ) => Promise<Map<string, boolean>>;
  /** Each wrapped run's compactions in time order, by run public id. */
  readCompactions?: (
    scope: FindingsScope,
    rootByRun: ReadonlyMap<string, string>,
    from: Date,
  ) => Promise<Map<string, RunCompaction[]>>;
  /** Each run's pull request outcomes, by run public id. */
  readOutcomes?: (
    scope: FindingsScope,
    runIds: readonly string[],
  ) => Promise<Map<string, OutcomeRow[]>>;
  /**
   * Whether a later step quoted each large tool result detector 5 can price
   * (decision 7); absent, the pass reads none, and detector 5 counts every
   * re-read, an upper bound.
   */
  readResultUse?: (
    scope: FindingsScope,
    results: readonly ToolCallObservation[],
    rootByRun: ReadonlyMap<string, string>,
  ) => Promise<ResultUseRead>;
  write: (
    scope: FindingsScope,
    passStartedAt: Date,
    decidedSince: ReadonlyMap<string, Date>,
    drafts: readonly FindingDraft[],
  ) => Promise<number>;
  /**
   * The applied findings of a claiming kind with no claim rows whose window
   * ends at or after `since`; absent, the pass backfills none.
   */
  readUnclaimedApplied?: (
    scope: FindingsScope,
    kinds: readonly string[],
    since: Date,
  ) => Promise<UnclaimedApplied[]>;
  /** Stores the claims a pass replayed for applied findings. */
  writeClaimBackfill?: (
    scope: FindingsScope,
    backfill: readonly ClaimBackfill[],
  ) => Promise<void>;
  /**
   * The workspace's weekly price per 1,000 tokens of standing context as of
   * `now`, which detector 2's values quote (#5023); absent, the pass reads
   * none and the values carry no price.
   */
  readWeeklyPrice?: (
    scope: FindingsScope,
    now: Date,
  ) => Promise<WeeklyContextPrice | null>;
}

/**
 * Where the tool-call window starts: the window's start, or the oldest call
 * read when the read hit its cap, so a finding never claims a stretch of the
 * window its calls were not read over.
 */
export function toolWindowStart(
  windowStart: Date,
  rows: readonly { at: string }[],
  limit: number,
): Date {
  if (rows.length < limit) return windowStart;
  let oldest = Number.POSITIVE_INFINITY;
  for (const r of rows) oldest = Math.min(oldest, Date.parse(r.at));
  return new Date(Math.max(oldest, windowStart.getTime()));
}

/**
 * The tool calls whose root session the window's runs name. A call on the
 * root's own chain carries no session, as a transcript body's frame does; a
 * subagent's call names its chain, since its `seq` counts on that chain alone
 * (#4001).
 */
export function toObservations(
  rows: readonly ToolCallObservationRow[],
  runIdBySession: ReadonlyMap<string, string>,
): ToolCallObservation[] {
  const out: ToolCallObservation[] = [];
  for (const r of rows) {
    const runId = runIdBySession.get(r.rootSessionUuid);
    if (runId === undefined) continue;
    out.push({
      runId,
      at: new Date(r.at),
      atMicros: microsOf(r.at),
      seq: r.seq,
      tool: r.tool,
      inputDigest: r.inputDigest,
      outputDigest: r.outputDigest,
      isMutating: r.isMutating,
      resultTokens: r.resultTokens,
      ...(r.resultTokensBasis === "estimated"
        ? { resultTokensBasis: "estimated" as const }
        : {}),
      sessionUuid: r.sessionUuid === r.rootSessionUuid ? null : r.sessionUuid,
      status: r.status,
      errorClass: r.errorClass,
    });
  }
  return out;
}

/**
 * Each run's file change times in microseconds, ascending, from the window's
 * `oxagen:file_changed` frames whose root session the window's runs name.
 * The read covers `from` onward: the window's start, or the oldest frame read
 * when the read hit its cap.
 */
export function fileChangeTimesOf(
  rows: readonly FileChangeRow[],
  runIdBySession: ReadonlyMap<string, string>,
  windowStart: Date,
  limit: number,
): NonNullable<DetectInput["fileChangeTimes"]> {
  const byRun = new Map<string, number[]>();
  for (const r of rows) {
    const runId = runIdBySession.get(r.rootSessionUuid);
    if (runId === undefined) continue;
    const list = byRun.get(runId) ?? [];
    list.push(microsOf(r.at));
    byRun.set(runId, list);
  }
  for (const list of byRun.values()) list.sort((a, b) => a - b);
  return { from: toolWindowStart(windowStart, rows, limit), byRun };
}

/**
 * The runs a pass reads model-call frames for: those with a repeat, most
 * repeats first, at most `limit`. Each read names the run's root chain and
 * every chain its tool calls name, so it scans only the run's own chains.
 */
export function frameReads(
  rows: readonly ToolCallObservationRow[],
  runIdBySession: ReadonlyMap<string, string>,
  repeatsByRun: ReadonlyMap<string, number>,
  limit: number,
): FrameRead[] {
  const chains = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!runIdBySession.has(r.rootSessionUuid)) continue;
    const set = chains.get(r.rootSessionUuid) ?? new Set([r.rootSessionUuid]);
    set.add(r.sessionUuid);
    chains.set(r.rootSessionUuid, set);
  }
  const rootByRun = new Map<string, string>();
  for (const [root, runId] of runIdBySession) rootByRun.set(runId, root);
  const ranked = [...repeatsByRun].sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1,
  );
  const out: FrameRead[] = [];
  for (const [runId] of ranked) {
    if (out.length >= limit) break;
    const root = rootByRun.get(runId);
    if (root === undefined) continue;
    const chain = chains.get(root) ?? new Set([root]);
    out.push({
      runId,
      ref: {
        kind: "tacho",
        rootSessionUuid: root,
        sessionUuids: [root, ...[...chain].filter((s) => s !== root).sort()],
      },
    });
  }
  return out;
}

/** Each wrapped run's root session uuid, by run public id. */
export function tachoRoots(
  runs: readonly RunTotalsRecord[],
  runIdBySession: ReadonlyMap<string, string>,
): Map<string, string> {
  const tacho = new Set(
    runs.filter((r) => r.runSource === "tacho").map((r) => r.runId),
  );
  const out = new Map<string, string>();
  for (const [root, runId] of runIdBySession)
    if (tacho.has(runId)) out.set(runId, root);
  return out;
}

/**
 * Two sources for one run, as one: a wrapped run's sessions are the union of
 * both, root first. Otherwise the store's source wins.
 */
function mergeRef(stored: FrameRunRef, fromCalls: FrameRunRef): FrameRunRef {
  if (
    stored.kind !== "tacho" ||
    fromCalls.kind !== "tacho" ||
    stored.rootSessionUuid !== fromCalls.rootSessionUuid
  )
    return stored;
  const root = stored.rootSessionUuid;
  const rest = new Set([...stored.sessionUuids, ...fromCalls.sessionUuids]);
  rest.delete(root);
  return {
    kind: "tacho",
    rootSessionUuid: root,
    sessionUuids: [root, ...[...rest].sort()],
  };
}

/** A wrapped run's frame source, which a group read names. */
type WrappedRef = Extract<FrameRunRef, { kind: "tacho" }>;

/** One run of a recurring group, as the plan reads it. */
interface GroupRun {
  read: FrameRead;
  ref: WrappedRef;
  /** The run's model calls in the rollup: about as many frames as the read returns. */
  calls: number;
}

/** A recurring group as the plan reads it (#5168). */
interface RecurringGroup {
  /** The job key recurring runs (detector 7) groups by. */
  job: string;
  /** The group's runs with a wrapped frame source, in rank order. */
  runs: GroupRun[];
  /** Every run of the group, read or not. */
  size: number;
  /** What every run of the group cost, in micros. */
  costMicros: bigint;
}

/**
 * The window's recurring groups, dearest first (#5168). A group is a job
 * whose first prompt started `RECURRING_RUNS_MIN` or more runs, grouped the
 * way recurring runs groups them (`runsByJob`). A person's prompt starts no
 * group. Each group read takes one place, whatever the group's size, so the
 * dearest group goes first: its finding can price the most. Two groups of one
 * cost go larger first, then by job key.
 */
function recurringGroups(
  runs: readonly RunTotalsRecord[],
  firstPrompts: ReadonlyMap<string, RunFirstPrompt>,
  matched: readonly FrameRead[],
): RecurringGroup[] {
  const groupOf = new Map<string, RecurringGroup>();
  const calls = new Map<string, number>();
  const out: RecurringGroup[] = [];
  for (const [job, list] of runsByJob(runs, firstPrompts)) {
    if (list.length < RECURRING_RUNS_MIN) continue;
    let costMicros = 0n;
    for (const run of list) costMicros += run.costMicros ?? 0n;
    const group: RecurringGroup = {
      job,
      runs: [],
      size: list.length,
      costMicros,
    };
    for (const run of list) {
      groupOf.set(run.runId, group);
      calls.set(run.runId, Math.max(0, run.modelCalls));
    }
    out.push(group);
  }
  // `matched` is in rank order. Only a wrapped run joins a group read, since
  // the read names root sessions.
  for (const read of matched) {
    const group = groupOf.get(read.runId);
    if (group === undefined || read.ref.kind !== "tacho") continue;
    group.runs.push({ read, ref: read.ref, calls: calls.get(read.runId)! });
  }
  return out.sort((a, b) => {
    if (a.costMicros !== b.costMicros)
      return a.costMicros > b.costMicros ? -1 : 1;
    if (a.size !== b.size) return b.size - a.size;
    return a.job < b.job ? -1 : a.job > b.job ? 1 : 0;
  });
}

/** The sessions a group read names for one run, its root included. */
function sessionsNamed(ref: WrappedRef): number {
  return ref.sessionUuids.includes(ref.rootSessionUuid)
    ? ref.sessionUuids.length
    : ref.sessionUuids.length + 1;
}

/** Bounds on a pass's frame plan (ADR-210). */
export interface FramePlanBounds {
  /** The reads kept for recurring groups. */
  groupReads: number;
  /** The frames every group read together may return, by the rollup's model calls. */
  groupFrames: number;
  /** The sessions one group read names at most. */
  groupSessions: number;
}

const FRAME_PLAN_BOUNDS: FramePlanBounds = {
  groupReads: FRAME_GROUP_READS_RESERVE,
  groupFrames: FRAME_READ_MAX_FRAMES,
  groupSessions: FRAME_GROUP_READ_SESSIONS,
};

/**
 * The group reads of a frame plan (#5168): at most `places` reads, the
 * dearest group first. A read covers runs of one group, in rank order, and
 * names at most `bounds.groupSessions` sessions. A group with more sessions
 * takes more reads, one place each. Returns the runs read, each tagged with
 * its read's number, and how many reads they take.
 *
 * Every group read together returns at most `bounds.groupFrames` frames, by
 * each run's model calls in the rollup. A group query returns all of its rows
 * at once, so the plan sizes the read before it runs. A group whose calls
 * would pass that bound takes its runs in rank order while they fit, and the
 * rest go back to the ranking. A group whose first run does not fit gets no
 * read.
 */
function planGroupReads(
  groups: readonly RecurringGroup[],
  places: number,
  bounds: FramePlanBounds,
): { reads: FrameRead[]; used: number } {
  const reads: FrameRead[] = [];
  let used = 0;
  let frames = bounds.groupFrames;
  const close = (runs: readonly GroupRun[], job: string) => {
    for (const run of runs) reads.push({ ...run.read, group: used, job });
    used += 1;
  };
  for (const group of groups) {
    if (used >= places) break;
    let open: GroupRun[] = [];
    let sessions = 0;
    for (const run of group.runs) {
      if (run.calls > frames) break;
      const named = sessionsNamed(run.ref);
      if (open.length > 0 && sessions + named > bounds.groupSessions) {
        close(open, group.job);
        open = [];
        sessions = 0;
        if (used >= places) break;
      }
      frames -= run.calls;
      sessions += named;
      open.push(run);
    }
    if (open.length > 0) close(open, group.job);
  }
  return { reads, used };
}

/**
 * The runs a pass reads model-call frames for, and what the plan left out
 * (ADR-210). The plan makes at most `limit` reads, and each read is one
 * ClickHouse query.
 *
 * Up to `bounds.groupReads` of them go to recurring groups (#5168). A group
 * read covers many runs of one recurring job, so a scheduled job is read
 * whole in one query however many runs it has. Its runs leave the ranking,
 * so no run is read twice. A place no group needs goes back to the ranking.
 *
 * The other places go to single runs, ranked most repeats first, then the
 * dearest, then by run id.
 *
 * The group reads come first in the read. When the frame cap stops the read,
 * it drops single runs at the end and keeps these. `capped` counts the runs
 * no read covers, and `unmatched` the runs with no source, so a detector can
 * tell a run with no frames from a run the pass did not read.
 */
export function planFrameReads(
  runs: readonly RunTotalsRecord[],
  refs: ReadonlyMap<string, FrameRunRef>,
  repeatsByRun: ReadonlyMap<string, number>,
  limit: number,
  firstPrompts: ReadonlyMap<string, RunFirstPrompt> = new Map(),
  bounds: Partial<FramePlanBounds> = {},
): { reads: FrameRead[]; coverage: FrameCoverage } {
  const cost = (r: RunTotalsRecord) => r.costMicros ?? -1n;
  const ranked = [...runs].sort((a, b) => {
    const ra = repeatsByRun.get(a.runId) ?? 0;
    const rb = repeatsByRun.get(b.runId) ?? 0;
    if (ra !== rb) return rb - ra;
    const ca = cost(a);
    const cb = cost(b);
    if (ca !== cb) return ca > cb ? -1 : 1;
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });
  const matched: FrameRead[] = [];
  let unmatched = 0;
  for (const run of ranked) {
    const ref = refs.get(run.runId);
    if (ref === undefined) unmatched += 1;
    else matched.push({ runId: run.runId, ref });
  }
  const places = Math.max(0, limit);
  const plan = { ...FRAME_PLAN_BOUNDS, ...bounds };
  const grouped = planGroupReads(
    recurringGroups(runs, firstPrompts, matched),
    Math.min(Math.max(0, plan.groupReads), places),
    plan,
  );
  const inGroup = new Set(grouped.reads.map((r) => r.runId));
  const single = matched
    .filter((r) => !inGroup.has(r.runId))
    .slice(0, places - grouped.used);
  const reads = [...grouped.reads, ...single];
  return {
    reads,
    coverage: {
      runs: runs.length,
      read: reads.length,
      capped: matched.length - reads.length,
      unmatched,
    },
  };
}

/**
 * Each run's frame source: the store's, when it read one, merged with the
 * chains the run's tool calls name.
 */
export function frameSources(
  runs: readonly RunTotalsRecord[],
  rows: readonly ToolCallObservationRow[],
  runIdBySession: ReadonlyMap<string, string>,
  stored: ReadonlyMap<string, FrameRunRef>,
): Map<string, FrameRunRef> {
  const every = new Map(runs.map((r) => [r.runId, 0]));
  const out = new Map<string, FrameRunRef>();
  for (const read of frameReads(
    rows,
    runIdBySession,
    every,
    Number.POSITIVE_INFINITY,
  ))
    out.set(read.runId, read.ref);
  for (const [runId, ref] of stored) {
    if (!every.has(runId)) continue;
    const fromCalls = out.get(runId);
    out.set(runId, fromCalls === undefined ? ref : mergeRef(ref, fromCalls));
  }
  return out;
}

/** One class's price entry at a frame's instant, as a frame carries it. */
function classPriceOf(
  classIndex: ReadonlyMap<PriceTokenClass, PriceBook>,
  orgId: string,
  model: string,
  at: Date,
  c: FrameTokenClass,
): FrameClassPrice | null {
  const entry = resolvePriceEntryFromClassBook(classIndex.get(c) ?? [], {
    orgId,
    modelId: model,
    at,
  });
  return entry === null
    ? null
    : {
        entryId: entry.id,
        microsPerMillion: entry.microsPerMillion,
        currency: entry.currency,
        source: entry.source,
      };
}

/** Every class's price entry at a frame's instant. */
function classPricesOf(
  classIndex: ReadonlyMap<PriceTokenClass, PriceBook>,
  orgId: string,
  model: string,
  at: Date,
): FrameClassPrices {
  const out = {} as Record<FrameTokenClass, FrameClassPrice | null>;
  for (const c of FRAME_TOKEN_CLASSES)
    out[c] = classPriceOf(classIndex, orgId, model, at, c);
  return out;
}

function toContextParts(
  row: ModelCallFrameRow,
): readonly FrameContextPart[] | undefined {
  return row.systemContextParts?.map((p) => ({
    kind: p.kind,
    name: p.name,
    ...(p.provider === undefined ? {} : { provider: p.provider }),
    digest: p.digest,
    tokens: p.tokens,
  }));
}

function toModelCallFrame(row: ModelCallFrameRow): ModelCallFrame {
  return {
    at: new Date(row.at),
    model: row.model,
    provider: row.provider,
    tokens: {
      input_uncached: row.inputUncached,
      cache_read: row.cacheRead,
      cache_write_5m: row.cacheWrite5m,
      cache_write_1h: row.cacheWrite1h,
      output: row.output,
      reasoning: row.reasoning,
      server_tool_request: row.serverToolRequests,
    },
    reportedCostMicros:
      row.reportedCostMicros === null ? null : BigInt(row.reportedCostMicros),
    basis: row.basis,
  };
}

/** A frame row's `at` text and every field it carries, in a fixed order. */
function rowContent(row: ModelCallFrameRow): string {
  return JSON.stringify([
    row.at,
    row.model,
    row.provider,
    row.inputUncached,
    row.cacheRead,
    row.cacheWrite5m,
    row.cacheWrite1h,
    row.output,
    row.reasoning,
    row.serverToolRequests,
    row.reportedCostMicros,
    row.basis,
    // Last, so frames that already differ keep the order they had before the
    // chain was read. Two chains' frames of one instant differ here alone.
    row.sessionUuid ?? null,
    // After the chain, for the same reason: two frames that differ only in
    // their system context keep one order from pass to pass.
    row.systemContextDigest ?? null,
  ]);
}

/**
 * A wrapped row's event identity: its chain and its `seq` on that chain. The
 * store never changes either, so a frame keeps the key built from them
 * whatever else a later read returns (#4506). Null on a ledger row, which has
 * neither.
 */
function eventIdentity(row: ModelCallFrameRow): string | null {
  return row.sessionUuid === undefined || row.seq === undefined
    ? null
    : `${row.sessionUuid}:${row.seq}`;
}

/**
 * The order of one instant's rows: a row with an event identity by its chain
 * and then its `seq`, ahead of a row without one, and those by content.
 */
function byIdentity(
  a: { row: ModelCallFrameRow; text: string },
  b: { row: ModelCallFrameRow; text: string },
): number {
  const idA = eventIdentity(a.row) !== null;
  const idB = eventIdentity(b.row) !== null;
  if (idA !== idB) return idA ? -1 : 1;
  if (idA) {
    const chainA = a.row.sessionUuid!;
    const chainB = b.row.sessionUuid!;
    if (chainA !== chainB) return chainA < chainB ? -1 : 1;
    return a.row.seq! - b.row.seq!;
  }
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

/**
 * One run's model-call frames, each priced once by the rollup's rule, in time
 * order to the microsecond. A frame's key is its `at` exactly as the store
 * printed it, then `#` and the frame's event identity: the chain it was
 * recorded on and its `seq` there. Neither changes, so a frame keeps its key
 * from one pass to the next, even when a frame of the same instant that a
 * later pass reads sorts ahead of it (#4506, ADR-208). A ledger frame has no
 * chain, so its key ends in its place among the run's ledger frames at that
 * instant, by content. Two such frames with the same content are
 * interchangeable.
 *
 * Each frame names its chain as a tool call does: null on `rootSessionUuid`,
 * the chain's uuid otherwise, and absent when the row names none.
 *
 * A row that names no model is kept as a `noModel` frame with no price: no
 * book entry covers it, and a figure the harness reported for it stays out
 * (#4506).
 *
 * Each frame also carries its model, its tokens and price entry per class,
 * its tool-definition, context-frame, and steering tokens, and its system
 * context digest. A recorder lists a digest's parts on the first frame that
 * carries the digest, so a later frame with the same digest takes the parts
 * the run last listed for it. A frame whose digest no earlier frame listed has
 * null parts (ADR-210).
 */
export function pricedFrames(
  book: PriceBook,
  orgId: string,
  rows: readonly ModelCallFrameRow[],
  rootSessionUuid: string | null,
  classIndex: ReadonlyMap<
    PriceTokenClass,
    PriceBook
  > = indexPriceBookByClass(book),
): PricedRequestFrame[] {
  const ordered = rows
    .map((row) => ({ row, micros: microsOf(row.at), text: rowContent(row) }))
    .sort((a, b) => a.micros - b.micros || byIdentity(a, b));
  // The ledger rows at each instant, so far; a wrapped row's key needs none.
  const atCount = new Map<string, number>();
  const partsByDigest = new Map<string, readonly FrameContextPart[]>();
  const out: PricedRequestFrame[] = [];
  for (const { row, micros } of ordered) {
    const identity = eventIdentity(row);
    let place = identity;
    if (place === null) {
      const n = atCount.get(row.at) ?? 0;
      atCount.set(row.at, n + 1);
      place = String(n);
    }
    const frame = toModelCallFrame(row);
    const noModel = row.model === "";
    const priced = noModel ? null : priceFrame(book, orgId, frame);
    const t = frame.tokens;
    const digest = row.systemContextDigest ?? null;
    const listed = toContextParts(row);
    if (digest !== null && listed !== undefined)
      partsByDigest.set(digest, listed);
    out.push({
      key: `${row.at}#${place}`,
      at: frame.at,
      atMicros: micros,
      costMicros:
        priced === null || priced.scaled === null
          ? null
          : divideHalfEven(priced.scaled, 1_000_000n),
      tokens:
        t.input_uncached +
        t.cache_read +
        t.cache_write_5m +
        t.cache_write_1h +
        t.output +
        t.reasoning,
      basis: priced === null ? null : priced.basis,
      ...(row.sessionUuid === undefined
        ? {}
        : {
            sessionUuid:
              row.sessionUuid === rootSessionUuid ? null : row.sessionUuid,
          }),
      model: frame.model,
      provider: frame.provider,
      classTokens: { ...t },
      classPrices: classPricesOf(classIndex, orgId, frame.model, frame.at),
      toolDefinitionTokens: row.toolDefinitionTokens,
      contextFrameTokens: row.contextFrameTokens,
      steeringTokens: row.steeringTokens,
      systemContextDigest: digest,
      systemContextParts:
        digest === null ? null : (partsByDigest.get(digest) ?? null),
      ...(row.cacheKeepAlive === true ? { cacheKeepAlive: true } : {}),
      ...(row.seq === undefined ? {} : { seq: row.seq }),
      ...(noModel ? { noModel: true as const } : {}),
    });
  }
  return out;
}

/**
 * A pass's frame reads split in two: the frames the detectors read, and the
 * `noModel` frames only the request view reads (#4506). Every run read keeps
 * an entry in the first, so a run whose calls all named no model still reads
 * as read.
 */
function splitModellessFrames(
  read: ReadonlyMap<string, readonly PricedRequestFrame[]>,
): {
  frames: Map<string, PricedRequestFrame[]>;
  modelless: Map<string, PricedRequestFrame[]>;
} {
  const frames = new Map<string, PricedRequestFrame[]>();
  const modelless = new Map<string, PricedRequestFrame[]>();
  for (const [runId, list] of read) {
    frames.set(runId, list.filter((f) => f.noModel !== true));
    const bounds = list.filter((f) => f.noModel === true);
    if (bounds.length > 0) modelless.set(runId, bounds);
  }
  return { frames, modelless };
}

/** One query of a pass's frame read: one run, or the runs of one group read. */
interface ReadUnit {
  runs: FrameRead[];
  group: boolean;
}

/**
 * The queries a frame read runs, in order. Wrapped runs side by side that
 * carry one group number are one query when the caller can read a group
 * (#5168). Every other run is a query of its own.
 */
function readUnits(runs: readonly FrameRead[], grouped: boolean): ReadUnit[] {
  const out: ReadUnit[] = [];
  for (const run of runs) {
    const last = out.at(-1);
    const joins =
      grouped && run.group !== undefined && run.ref.kind === "tacho";
    if (joins && last?.group === true && last.runs[0]!.group === run.group)
      last.runs.push(run);
    else out.push({ runs: [run], group: joins });
  }
  return out;
}

/**
 * The batches a frame read runs, in order (#5462). A group read is a batch on
 * its own, so one group query runs at a time. In production on 2026-10-03
 * each group read scanned 6 to 14 million rows, two to four times the rows
 * the table holds, and up to eight of them ran at once. Runs read alone share
 * a batch of up to `concurrency` queries.
 */
function readBatches(
  units: readonly ReadUnit[],
  concurrency: number,
): ReadUnit[][] {
  const out: ReadUnit[][] = [];
  for (const unit of units) {
    const last = out.at(-1);
    if (
      !unit.group &&
      last !== undefined &&
      !last[0]!.group &&
      last.length < concurrency
    )
      last.push(unit);
    else out.push([unit]);
  }
  return out;
}

/**
 * Each run's rows from `read`, in the order the runs are given, while the
 * rows the pass holds stay at or under `cap` (#4506). Up to `concurrency`
 * single-run queries run at once, and a group read through `readGroup` runs
 * alone (#5168, #5462). Results are admitted in order. A group's runs are
 * admitted one by one, in order. The first run whose rows would pass the cap
 * is dropped whole, since a detector needs all of a run's frames. Every run
 * after it is dropped too, in its group or after it, and no later batch is
 * read. `peak` is the most rows the pass kept. The batch in flight adds at
 * most its own queries' rows until they are admitted or dropped.
 *
 * When `readGroup` answers null, the store refused that group read. Its runs
 * are left out of the answer, so the pass counts them as capped, and the read
 * goes on with the next batch (#5462).
 */
export async function readFrameRows<T>(
  runs: readonly FrameRead[],
  read: (run: FrameRead) => Promise<T[]>,
  cap: number,
  concurrency: number = FRAME_READ_CONCURRENCY,
  readGroup?: (
    runs: readonly FrameRead[],
  ) => Promise<ReadonlyMap<string, T[]> | null>,
): Promise<{ rows: Map<string, T[]>; peak: number }> {
  const units = readUnits(runs, readGroup !== undefined);
  const rows = new Map<string, T[]>();
  let held = 0;
  let peak = 0;
  for (const batch of readBatches(units, concurrency)) {
    const results = await Promise.all(
      batch.map(async (unit): Promise<ReadonlyMap<string, T[]> | null> => {
        if (unit.group) return readGroup!(unit.runs);
        const run = unit.runs[0]!;
        return new Map([[run.runId, await read(run)]]);
      }),
    );
    for (let j = 0; j < batch.length; j += 1) {
      const got = results[j];
      // A refused group read: its runs stay unread.
      if (got === null || got === undefined) continue;
      for (const run of batch[j]!.runs) {
        const list = got.get(run.runId) ?? [];
        if (held + list.length > cap) return { rows, peak };
        held += list.length;
        peak = Math.max(peak, held);
        rows.set(run.runId, list);
      }
    }
  }
  return { rows, peak };
}

/**
 * ClickHouse server error codes that refuse a read for its size or for the
 * store's load (#5462): over the memory limit (241), over the time limit
 * (159), and too many queries or no free connection (202, 203). These are the
 * read codes in `CLICKHOUSE_BACKPRESSURE_REASONS` (@oxagen/telemetry), with
 * the time limit added. A read refused for its time limit is refused again on
 * a retry, so the pass does not wait for it.
 */
const FRAME_READ_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "241",
  "159",
  "202",
  "203",
]);

/** The code the circuit breaker gives a call it refuses before sending it. */
const CIRCUIT_OPEN_CODE = "CIRCUIT_OPEN";

/**
 * The code of the ClickHouse refusal `err` is, or null for any other failure
 * (#5462). It reads the error's `code` and `message`, as
 * `storeOverloadedFrom` in @oxagen/telemetry does, because a refusal arrives
 * in three shapes:
 *
 * - `@clickhouse/client` parses a server error into an error with its `code`
 *   ("241" or "159").
 * - The circuit breaker refuses a call with the code `CIRCUIT_OPEN`.
 * - The client's own request timeout fires with the message "Timeout error."
 *   and no code. It waits 30 seconds by default, the same as the reads'
 *   `max_execution_time`, so either one can end a slow read first. This one
 *   returns `client_timeout`.
 *
 * A server error the client could not parse keeps its text, so a message
 * that says the memory or time limit was exceeded counts too.
 */
export function frameReadRefusal(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const raw = (err as { code?: unknown }).code;
  const code = typeof raw === "number" ? String(raw) : raw;
  if (code === CIRCUIT_OPEN_CODE) return CIRCUIT_OPEN_CODE;
  if (typeof code === "string" && FRAME_READ_REFUSAL_CODES.has(code))
    return code;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  if (/^Timeout error\.?$/.test(message)) return "client_timeout";
  if (/memory limit.*exceeded/i.test(message)) return "241";
  if (/timeout exceeded/i.test(message)) return "159";
  return null;
}

/**
 * One group read's rows, by run public id (#5168). Every run of a group read
 * is wrapped, so each is named by its root session.
 *
 * Null when the store refuses the read ({@link frameReadRefusal}), after one
 * warning that names the group's job key, its run count, and the code
 * (#5462). The caller leaves the group's runs unread, and the pass counts
 * them as capped, so recurring runs (detector 7) prices none of them this
 * pass. A recurring job too large for the store then costs the pass that
 * job's finding, and every other finding is still written. Any other error
 * fails the read.
 */
async function readGroupRows(
  scope: FindingsScope,
  runs: readonly FrameRead[],
  keepModelless: boolean,
): Promise<Map<string, ModelCallFrameRow[]> | null> {
  const wrapped = runs.flatMap((r) =>
    r.ref.kind === "tacho" ? [{ runId: r.runId, ref: r.ref }] : [],
  );
  const refs = wrapped.map((r) => r.ref);
  let byRoot: Map<string, ModelCallFrameRow[]>;
  try {
    byRoot = await readGroupModelCallFrames(
      keepModelless
        ? { ...scope, runs: refs, keepModelless: true }
        : { ...scope, runs: refs },
    );
  } catch (err) {
    const code = frameReadRefusal(err);
    if (code === null) throw err;
    logger.warn(
      { ...scope, job: runs[0]?.job ?? null, runs: runs.length, code, err },
      "findings: the store refused a recurring group's frame read, so its runs count as capped",
    );
    return null;
  }
  return new Map(
    wrapped.map((r) => [r.runId, byRoot.get(r.ref.rootSessionUuid) ?? []]),
  );
}

/** Reads one group's rows, or answers null when the store refused the read. */
type GroupRowsReader = (
  runs: readonly FrameRead[],
) => Promise<Map<string, ModelCallFrameRow[]> | null>;

/**
 * The group reader one priced read uses (#5462). It reads each group through
 * {@link readGroupRows} until the store has refused
 * {@link FRAME_GROUP_READ_REFUSALS_MAX} of them. It then skips every group
 * left, with one warning each, and returns null for it, so those runs count
 * as capped too.
 */
function groupReader(
  scope: FindingsScope,
  keepModelless: boolean,
): GroupRowsReader {
  let refusals = 0;
  return async (runs) => {
    if (refusals >= FRAME_GROUP_READ_REFUSALS_MAX) {
      logger.warn(
        { ...scope, job: runs[0]?.job ?? null, runs: runs.length, refusals },
        "findings: skipped a recurring group's frame read after the store refused earlier ones, so its runs count as capped",
      );
      return null;
    }
    const rows = await readGroupRows(scope, runs, keepModelless);
    if (rows === null) refusals += 1;
    return rows;
  };
}

/** The price book slice that covers every row: their models and their span. */
function rowsPriceSlice(
  orgId: string,
  rows: Iterable<readonly ModelCallFrameRow[]>,
): PriceBookSlice {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const models = new Set<string>();
  for (const list of rows)
    for (const row of list) {
      // A row that names no model is never priced.
      if (row.model === "") continue;
      models.add(row.model);
      const at = new Date(row.at).getTime();
      if (at < from) from = at;
      if (at > to) to = at;
    }
  if (models.size === 0) {
    const epoch = new Date(0);
    return { orgId, models: [], from: epoch, to: epoch };
  }
  return { orgId, models: [...models], from: new Date(from), to: new Date(to) };
}

/**
 * The named runs' priced model-call frames, by run public id, holding at most
 * `cap` frames (#4506). A run left out by the cap is absent from the answer,
 * and the pass counts it as capped. Each run's rows are priced and released
 * in turn, so the pass never holds a second copy of every frame.
 *
 * Runs with one group number are read in one query (#5168). Each run's rows
 * are then priced on their own, under the run's own root, so a frame gets the
 * key it gets from a read of its run alone. A group read the store refuses
 * leaves its runs absent too, like the cap does (#5462).
 *
 * With `keepModelless`, a run's calls that named no model come back too, as
 * `noModel` frames with no price, and count toward the cap (#4506).
 */
export async function readPricedFrames(
  scope: FindingsScope,
  runs: readonly FrameRead[],
  cap: number = FRAME_READ_MAX_FRAMES,
  keepModelless = false,
): Promise<Map<string, PricedRequestFrame[]>> {
  const { rows } = await readFrameRows(
    runs,
    (r) =>
      readModelCallFrames(
        keepModelless
          ? { ...scope, run: r.ref, keepModelless: true }
          : { ...scope, run: r.ref },
      ),
    cap,
    FRAME_READ_CONCURRENCY,
    groupReader(scope, keepModelless),
  );
  const book = await loadPriceBookSlice(
    rowsPriceSlice(scope.orgId, rows.values()),
  );
  const classIndex = indexPriceBookByClass(book);
  const out = new Map<string, PricedRequestFrame[]>();
  for (const run of runs) {
    const list = rows.get(run.runId);
    if (list === undefined) continue;
    rows.delete(run.runId);
    const root = run.ref.kind === "tacho" ? run.ref.rootSessionUuid : null;
    out.set(
      run.runId,
      pricedFrames(book, scope.orgId, list, root, classIndex),
    );
  }
  return out;
}

function readFrames(
  scope: FindingsScope,
  runs: readonly FrameRead[],
): Promise<Map<string, PricedRequestFrame[]>> {
  return readPricedFrames(scope, runs);
}

/** The pass's own frame read: the priced frames and the `noModel` ones (#4506). */
function readPassFrames(
  scope: FindingsScope,
  runs: readonly FrameRead[],
): Promise<Map<string, PricedRequestFrame[]>> {
  return readPricedFrames(scope, runs, FRAME_READ_MAX_FRAMES, true);
}

/**
 * The drafts a pass may write: a draft whose fingerprint carries a decision
 * the pass did not read (none in the decisions it detected with, or a later
 * one) is left to that decision. The comparison is between two decided_at
 * values the database stored, so no clock but the decision's own is read.
 */
export function undecidedDrafts(
  drafts: readonly FindingDraft[],
  decidedNow: ReadonlyMap<string, Date>,
  decidedSince: ReadonlyMap<string, Date>,
): FindingDraft[] {
  return drafts.filter((d) => {
    const now = decidedNow.get(d.fingerprint);
    if (now === undefined) return true;
    const read = decidedSince.get(d.fingerprint);
    return read !== undefined && now.getTime() <= read.getTime();
  });
}

/**
 * The workspace's run rows that started in the window. The in-app assistant's
 * runs are left out (ADR-235, 2026-10-02 amendment): a finding names its runs
 * as evidence, and the workspace does not monitor the assistant.
 */
async function readRuns(
  scope: FindingsScope,
  window: { start: Date; end: Date },
): Promise<RunTotalsRecord[]> {
  // tenancy: the scheduled findings job runs outside a tenant scope, and the
  // query is filtered by the scope's orgId and workspaceId.
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(totals.startedAt, window.start),
          lt(totals.startedAt, window.end),
          sql`not ${inAppRunTotal()}`,
        ),
      ),
  );
  return rows.map(runTotalsRowToRecord);
}

async function readRootSessions(
  scope: FindingsScope,
  start: Date,
): Promise<Map<string, string>> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({ uuid: sessions.sessionUuid, publicId: sessions.publicId })
      .from(sessions)
      .where(
        and(
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
          isNull(sessions.parentSessionUuid),
          gte(sessions.startedAt, start),
        ),
      ),
  );
  return new Map(rows.map((r) => [r.uuid, r.publicId]));
}

type SystemTx = Parameters<Parameters<typeof withSystemDb>[0]>[0];

/** Per fingerprint, the latest decision on it. */
async function decisionsOf(
  tx: SystemTx,
  scope: FindingsScope,
): Promise<Map<string, Date>> {
  const rows = await tx
    .select({
      fingerprint: findings.fingerprint,
      decidedAt: sql<Date>`max(${findings.decidedAt})`.mapWith(
        findings.decidedAt,
      ),
    })
    .from(findings)
    .where(
      and(
        eq(findings.orgId, scope.orgId),
        eq(findings.workspaceId, scope.workspaceId),
        ne(findings.status, "open"),
      ),
    )
    .groupBy(findings.fingerprint);
  return new Map(rows.map((r) => [r.fingerprint, r.decidedAt]));
}

function readDecisions(scope: FindingsScope): Promise<Map<string, Date>> {
  return withSystemDb((tx) => decisionsOf(tx, scope));
}

/** The start of every repeated instruction lineage: `ctx.habits.instruction-`. */
const INSTRUCTION_LINEAGE_PREFIX = instructionLineage("");

/**
 * The workspace's repeated instruction lineages that already have a steering
 * record or a proposal, in any state, in lower case (#4579). The opener checks
 * the same two tables under its lock and refuses a taken lineage. So a lineage
 * this read misses costs the pass one proposal, and the opener still never
 * opens a lineage twice. The read runs in the workspace's tenant scope, as the
 * opener does, so it reads the same data plane.
 */
export async function readTakenLineages(
  scope: FindingsScope,
): Promise<Set<string>> {
  const pattern = `${INSTRUCTION_LINEAGE_PREFIX}%`;
  const rows = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select({ lineage: records.slug })
        .from(records)
        .where(
          and(
            eq(records.orgId, scope.orgId),
            eq(records.workspaceId, scope.workspaceId),
            ilike(records.slug, pattern),
          ),
        )
        .union(
          tx
            .select({ lineage: proposals.lineageId })
            .from(proposals)
            .where(
              and(
                eq(proposals.orgId, scope.orgId),
                eq(proposals.workspaceId, scope.workspaceId),
                ilike(proposals.lineageId, pattern),
              ),
            ),
        ),
    ),
  );
  return new Set(rows.map((r) => r.lineage.toLowerCase()));
}

/**
 * The taken lineages, or undefined when the read fails. The findings are
 * already written by then, and the opener refuses a taken lineage on its own,
 * so a failed read costs the pass some proposals and nothing else. Failing
 * the pass would rerun every read for the workspace.
 */
async function takenOrNone(
  scope: FindingsScope,
  read: (scope: FindingsScope) => Promise<ReadonlySet<string>>,
): Promise<ReadonlySet<string> | undefined> {
  try {
    return await read(scope);
  } catch (err) {
    logger.warn(
      { ...scope, err },
      "findings: reading taken instruction lineages failed",
    );
    return undefined;
  }
}

/**
 * Replace the workspace's open findings with the pass's, in one transaction:
 * an open row the pass no longer proves is deleted, and a proven one is
 * upserted on its fingerprint so its public id survives the pass.
 *
 * The transaction locks the workspace's open rows before it reads the
 * decisions again. A decision that committed before the lock and is missing
 * from `decidedSince`, the decisions the drafts were detected with, leaves its
 * fingerprint's draft unwritten; one that arrives after the lock waits on its
 * row and applies once the pass commits. Without the lock, a decision
 * committing between the read and the upsert takes its row out of the
 * open-fingerprint index, and the upsert inserts a fresh open row over it.
 */
export async function writeFindings(
  scope: FindingsScope,
  passStartedAt: Date,
  decidedSince: ReadonlyMap<string, Date>,
  drafts: readonly FindingDraft[],
): Promise<number> {
  // tenancy: the scheduled findings job runs outside a tenant scope, and every
  // statement here is filtered by the pass's orgId and workspaceId.
  return withSystemDb(async (tx) => {
    await tx
      .select({ id: findings.id })
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.status, "open"),
        ),
      )
      .for("update");
    const keep = undecidedDrafts(
      drafts,
      await decisionsOf(tx, scope),
      decidedSince,
    );
    await tx.delete(findings).where(
      and(
        eq(findings.orgId, scope.orgId),
        eq(findings.workspaceId, scope.workspaceId),
        eq(findings.status, "open"),
        keep.length === 0
          ? undefined
          : notInArray(
              findings.fingerprint,
              keep.map((d) => d.fingerprint),
            ),
      ),
    );
    for (const d of keep) {
      const values = {
        kind: d.kind,
        level: d.level,
        subject: d.subject,
        windowStart: d.windowStart,
        windowEnd: d.windowEnd,
        estimatedSavingMicros: d.savingMicros,
        currency: d.currency,
        savingBasis: d.basis,
        confidence: d.confidence,
        why: d.why,
        fix: d.fix,
        citedRuns: d.citedRuns,
        citedFrames: d.evidence,
        detectedAt: passStartedAt,
      };
      const [row] = await tx
        .insert(findings)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          fingerprint: d.fingerprint,
          ...values,
        })
        .onConflictDoUpdate({
          target: [findings.workspaceId, findings.fingerprint],
          targetWhere: sql`${findings.status} = 'open'`,
          set: values,
        })
        .returning({ id: findings.id });
      if (row) await writeClaims(tx, scope, row.id, d);
    }
    return keep.length;
  });
}

/**
 * Replace one open finding's claims with its draft's (ADR-208). A deleted
 * finding takes its claims with it through the foreign key.
 */
async function writeClaims(
  tx: SystemTx,
  scope: FindingsScope,
  findingId: string,
  draft: FindingDraft,
): Promise<void> {
  await tx
    .delete(claims)
    .where(
      and(
        eq(claims.orgId, scope.orgId),
        eq(claims.workspaceId, scope.workspaceId),
        eq(claims.findingId, findingId),
      ),
    );
  const rows = (draft.claims ?? []).map((c) => ({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    findingId,
    detector: c.detector,
    runId: c.runId,
    frameKey: c.frameKey,
    frameAt: c.frameAt,
    operatorKey: c.operatorKey,
    costMicros: c.costMicros,
    currency: draft.currency,
  }));
  for (let i = 0; i < rows.length; i += CLAIM_INSERT_CHUNK)
    await tx
      .insert(claims)
      .values(rows.slice(i, i + CLAIM_INSERT_CHUNK))
      .onConflictDoNothing();
}

/** One claimed frame as the unproductive spend readers select it. */
export type UnproductiveClaim = ClaimRow & { currency: string };

/**
 * The claims behind the unproductive spend headline over a window (ADR-208):
 * the frames that open and applied findings claim and that ran in the window.
 * A dismissed finding's claims do not count. The org and workspace predicates
 * hold on a tenant or a system transaction alike. `countClaims` turns the
 * rows into the headline, and the operator ranking reads the same rows for
 * its runs, so the two agree.
 */
export async function readUnproductiveClaims(
  tx: Tx,
  scope: FindingsScope,
  window: { start: Date; end: Date },
): Promise<UnproductiveClaim[]> {
  return tx
    .select({
      detector: claims.detector,
      runId: claims.runId,
      frameKey: claims.frameKey,
      operatorKey: claims.operatorKey,
      costMicros: claims.costMicros,
      currency: claims.currency,
    })
    .from(claims)
    .innerJoin(findings, eq(findings.id, claims.findingId))
    .where(
      and(
        eq(claims.orgId, scope.orgId),
        eq(claims.workspaceId, scope.workspaceId),
        eq(findings.orgId, scope.orgId),
        eq(findings.workspaceId, scope.workspaceId),
        gte(claims.frameAt, window.start),
        lt(claims.frameAt, window.end),
        inArray(findings.status, ["open", "applied"]),
      ),
    );
}

/**
 * The unproductive spend headline over a window, and each operator's share
 * of it (ADR-208). It adds the frames `readUnproductiveClaims` returns. A
 * frame counts once, under the first detector in counting order that claims
 * it, so the operator totals sum to the headline.
 */
export async function readUnproductiveSpend(
  tx: Tx,
  scope: FindingsScope,
  window: { start: Date; end: Date },
): Promise<UnproductiveSpend> {
  return countClaims(await readUnproductiveClaims(tx, scope, window));
}

/** An applied finding with no claim rows, as the backfill reads it. */
export interface UnclaimedApplied {
  id: string;
  fingerprint: string;
  citedRuns: readonly string[];
  currency: string;
}

/** The claims a pass replayed for one applied finding. */
export interface ClaimBackfill {
  findingId: string;
  currency: string;
  claims: FindingClaim[];
}

/** The kinds whose findings claim frames: those of detectors 1, 7, and 8. */
export const CLAIMING_KINDS: readonly string[] = DETECTORS.filter(
  (d) => d.counting !== null,
).flatMap((d) => d.kinds);

/**
 * The claims an applied finding gets from a replay of the pass (#4506): the
 * frames the replay claims under the finding's fingerprint, in the runs the
 * finding cited. A finding applied before `cost.finding_claims` existed has
 * no claim rows, and a pass replaces open findings only, so without this the
 * headline leaves out the frames it priced. A finding the replay gives no
 * claim is left out.
 */
export function claimBackfill(
  unclaimed: readonly UnclaimedApplied[],
  replayed: ReadonlyMap<string, readonly FindingClaim[]>,
): ClaimBackfill[] {
  const out: ClaimBackfill[] = [];
  for (const f of unclaimed) {
    const cited = new Set(f.citedRuns);
    const claims = (replayed.get(f.fingerprint) ?? []).filter((c) =>
      cited.has(c.runId),
    );
    if (claims.length > 0)
      out.push({ findingId: f.id, currency: f.currency, claims });
  }
  return out;
}

/**
 * The workspace's applied findings of `kinds` that hold no claim row, and
 * whose window ends at or after `since`: an older one's runs are out of the
 * pass's window, so a replay cannot find its frames.
 */
export async function readUnclaimedApplied(
  scope: FindingsScope,
  kinds: readonly string[],
  since: Date,
): Promise<UnclaimedApplied[]> {
  if (kinds.length === 0) return [];
  // tenancy: the scheduled findings job runs outside a tenant scope, and both
  // tables are filtered by the pass's orgId and workspaceId.
  return withSystemDb((tx) =>
    tx
      .select({
        id: findings.id,
        fingerprint: findings.fingerprint,
        citedRuns: findings.citedRuns,
        currency: findings.currency,
      })
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.status, "applied"),
          inArray(findings.kind, [...kinds]),
          gte(findings.windowEnd, since),
          notExists(
            tx
              .select({ id: claims.id })
              .from(claims)
              .where(
                and(
                  eq(claims.orgId, scope.orgId),
                  eq(claims.workspaceId, scope.workspaceId),
                  eq(claims.findingId, findings.id),
                ),
              ),
          ),
        ),
      ),
  );
}

/**
 * Store the claims a pass replayed for applied findings. A claim already
 * stored for the same finding, run, and frame is kept, so a second pass
 * writes nothing new.
 */
export async function writeClaimBackfill(
  scope: FindingsScope,
  backfill: readonly ClaimBackfill[],
): Promise<void> {
  const rows = backfill.flatMap((b) =>
    b.claims.map((c) => ({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      findingId: b.findingId,
      detector: c.detector,
      runId: c.runId,
      frameKey: c.frameKey,
      frameAt: c.frameAt,
      operatorKey: c.operatorKey,
      costMicros: c.costMicros,
      currency: b.currency,
    })),
  );
  if (rows.length === 0) return;
  // tenancy: the scheduled findings job runs outside a tenant scope, and every
  // row it writes carries the pass's orgId and workspaceId.
  await withSystemDb(async (tx) => {
    for (let i = 0; i < rows.length; i += CLAIM_INSERT_CHUNK)
      await tx
        .insert(claims)
        .values(rows.slice(i, i + CLAIM_INSERT_CHUNK))
        .onConflictDoNothing();
  });
}

const productionDeps: FindingsPassDeps = {
  now: () => new Date(),
  readRuns,
  readRootSessions,
  readToolCalls: readTachoToolCallObservations,
  readFileChangeRows: readTachoFileChanges,
  readFrames: readPassFrames,
  readDecisions,
  readRunRefs,
  readFirstPrompts,
  readFileChanges,
  readCompactions,
  readOutcomes,
  readResultUse,
  write: writeFindings,
  readUnclaimedApplied,
  writeClaimBackfill,
  readPrompts: (scope, window, runIdBySession, runIds) =>
    readRunPrompts(scope, window, runIdBySession, runIds, readFrames),
  openProposals: openSpendProposals,
  readTakenLineages,
  // The price reads the book through the tenant connection, as the tool and
  // steering pages do, so the card quotes the same price they do.
  readWeeklyPrice: (scope, now) =>
    runInTenantScope(scope, () => readWeeklyContextPrice(scope, now)),
};

/**
 * One findings pass over a workspace's trailing window: read the run rows,
 * the tool calls, the file change frames, and each run's first prompt, file
 * changes, compactions, and outcomes; read and price model-call frames in up
 * to `FRAME_READS_MAX` queries and `FRAME_READ_MAX_FRAMES` frames, with
 * `FRAME_GROUP_READS_RESERVE` of those queries kept for recurring groups, each
 * of which reads a scheduled job's runs in one query (#5168); detect; and
 * replace the open findings and their claims. The pass then gives
 * each applied finding with no claim row the claims a replay finds for it. It
 * also reads the window's operator prompts, and opens the steering record
 * proposals its repeated instructions and findings support. A decision on a
 * repeated instructions finding holds for its proposal too, and a lineage
 * that already has a record or a proposal does not use up the pass's cap
 * (#4579). Throws when a store is degraded: the job retries rather than
 * writing findings from missing frames. One exception: when ClickHouse
 * refuses a recurring group's frame read for memory, time, or load, that
 * group's runs count as capped and the pass goes on (#5462). The store
 * refuses that read again on every retry, and from 2026-09-28 one such read
 * kept every finding in its workspace from refreshing.
 */
export async function runFindingsPass(
  scope: FindingsScope,
  deps: FindingsPassDeps = productionDeps,
): Promise<{ findings: number }> {
  const end = deps.now();
  const start = new Date(end.getTime() - FINDINGS_WINDOW_DAYS * DAY_MS);
  const [runs, runIdBySession, rows, decidedSince, changeRows] =
    await Promise.all([
      deps.readRuns(scope, { start, end }),
      deps.readRootSessions(scope, start),
      deps.readToolCalls({
        ...scope,
        from: start,
        to: end,
        limit: TOOL_CALL_READ_MAX,
      }),
      deps.readDecisions(scope),
      deps.readFileChangeRows?.({
        ...scope,
        from: start,
        to: end,
        limit: FILE_CHANGE_READ_MAX,
      }),
    ]);
  const runIds = new Set(runs.map((r) => r.runId));
  const toolCalls = toObservations(rows, runIdBySession).filter((c) =>
    runIds.has(c.runId),
  );
  const fileChangeTimes =
    changeRows === undefined
      ? undefined
      : fileChangeTimesOf(
          changeRows,
          runIdBySession,
          start,
          FILE_CHANGE_READ_MAX,
        );
  const rootByRun = tachoRoots(runs, runIdBySession);
  const [stored, firstPrompts, fileChanges, compactions, outcomes] =
    await Promise.all([
      deps.readRunRefs?.(scope, runs, runIdBySession) ??
        new Map<string, FrameRunRef>(),
      deps.readFirstPrompts?.(scope, rootByRun, start) ??
        new Map<string, RunFirstPrompt>(),
      deps.readFileChanges?.(scope, rootByRun) ?? new Map<string, boolean>(),
      deps.readCompactions?.(scope, rootByRun, start) ??
        new Map<string, RunCompaction[]>(),
      deps.readOutcomes?.(scope, [...runIds]) ??
        new Map<string, OutcomeRow[]>(),
    ]);
  // A run with a retry loop is ranked with the runs that repeat, so its
  // retries are priced too.
  const ranked = runsWithRepeats(toolCalls);
  for (const [runId, n] of runsWithRetries(toolCalls, fileChangeTimes))
    ranked.set(runId, (ranked.get(runId) ?? 0) + n);
  // Each recurring group's runs are read in one query, so recurring runs can
  // price a scheduled job of any size in a busy workspace (#5168).
  const { reads, coverage } = planFrameReads(
    runs,
    frameSources(runs, rows, runIdBySession, stored),
    ranked,
    FRAME_READS_MAX,
    firstPrompts,
  );
  // A call that named no model bounds a request and is priced by nothing, so
  // only the request view reads it (#4506).
  const { frames, modelless } = splitModellessFrames(
    reads.length === 0
      ? new Map<string, PricedRequestFrame[]>()
      : await deps.readFrames(scope, reads),
  );
  // A planned run the frame cap left unread is absent from the answer, and
  // counts as capped (#4506).
  const unread = reads.filter((r) => !frames.has(r.runId)).length;
  const frameCoverage =
    unread === 0
      ? coverage
      : {
          ...coverage,
          read: coverage.read - unread,
          capped: coverage.capped + unread,
        };
  // Detector 5 splits each large result's re-reads by whether a later step
  // quoted the result.
  const toCheck = resultsToCheck(toolCalls, frames);
  const resultUse =
    toCheck.length === 0
      ? undefined
      : await deps.readResultUse?.(scope, toCheck, rootByRun);
  // A workspace with no runs in the window has no prompt to read.
  const prompts =
    runIds.size === 0
      ? undefined
      : await deps.readPrompts?.(scope, { start, end }, runIdBySession, runIds);
  // Detector 2 quotes the week's price per 1,000 tokens (#5023). A workspace
  // with no runs in the window has no finding to quote it on. A failed read
  // fails the pass, as every other read does, so the job retries rather than
  // write a finding whose price reads as not recorded.
  const weeklyPrice =
    runIds.size === 0
      ? undefined
      : await deps.readWeeklyPrice?.(scope, end);
  const input: DetectReads = {
    window: { start, end },
    toolWindowStart: toolWindowStart(start, rows, TOOL_CALL_READ_MAX),
    runs,
    toolCalls,
    decidedSince,
    frames,
    firstPrompts,
    fileChanges,
    compactions,
    outcomes,
    frameCoverage,
    ...(modelless.size > 0 ? { modellessFrames: modelless } : {}),
    ...(fileChangeTimes ? { fileChangeTimes } : {}),
    ...(prompts ? { prompts } : {}),
    ...(resultUse ? { resultUse } : {}),
    ...(weeklyPrice === undefined
      ? {}
      : {
          weeklyContextPrice:
            weeklyPrice === null
              ? null
              : {
                  perThousandMicros: weeklyPrice.perThousandMicros,
                  currency: weeklyPrice.currency,
                },
        }),
  };
  const drafts = detectFindings(input);
  const written = await deps.write(scope, end, decidedSince, drafts);
  const unclaimed =
    (await deps.readUnclaimedApplied?.(scope, CLAIMING_KINDS, start)) ?? [];
  if (unclaimed.length > 0) {
    const released = new Set(unclaimed.map((f) => f.fingerprint));
    const backfill = claimBackfill(unclaimed, replayClaims(input, released));
    if (backfill.length > 0) await deps.writeClaimBackfill?.(scope, backfill);
  }
  if (deps.openProposals === undefined) return { findings: written };
  // Only a `content_exact` workspace gets instruction proposals, so only its
  // pass reads which lineages are taken (#4579).
  const taken =
    prompts?.mode === "content_exact" && deps.readTakenLineages !== undefined
      ? await takenOrNone(scope, deps.readTakenLineages)
      : undefined;
  await deps.openProposals(scope, {
    instructions: instructionProposals(prompts, runs, { decidedSince, taken }),
    findings: drafts,
  });
  return { findings: written };
}

/**
 * What the nightly pass visits: the workspaces with a run row in the trailing
 * findings window, and the workspaces that still hold an open finding. A
 * workspace whose runs stopped gets a pass with no runs, which deletes its
 * open findings, so they age out with their runs.
 */
export async function listWorkspacesForFindings(
  now: Date,
): Promise<FindingsScope[]> {
  const start = new Date(now.getTime() - FINDINGS_WINDOW_DAYS * DAY_MS);
  return withSystemDb((tx) =>
    tx
      .select({ orgId: totals.orgId, workspaceId: totals.workspaceId })
      .from(totals)
      .where(gte(totals.startedAt, start))
      .union(
        tx
          .select({ orgId: findings.orgId, workspaceId: findings.workspaceId })
          .from(findings)
          .where(eq(findings.status, "open")),
      ),
  );
}
