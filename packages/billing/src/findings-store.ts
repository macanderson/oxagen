/**
 * findings-store.ts — the reads and writes around the pure detectors
 * (./findings/): a workspace's run rows and root sessions from Postgres, its
 * tool-call frames and model-call frames from ClickHouse, and the
 * `cost.findings` and `cost.finding_claims` rows (Mission Control spec
 * §12.8; ADR-062, ADR-208).
 *
 * The findings job runs on the system connection with explicit org and
 * workspace predicates, outside a tenant scope. Handlers read the rows
 * through withTenantDb in their own modules.
 */
import { schema, withSystemDb, type Tx } from "@oxagen/database";
import {
  readModelCallFrames,
  readTachoToolCallObservations,
  type FrameRunRef,
  type ModelCallFrameRow,
  type ToolCallObservationRow,
} from "@oxagen/telemetry";
import {
  and,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
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
import { runPriceSlice, runTotalsRowToRecord } from "./cost-rollup-store";
import {
  countClaims,
  detectFindings,
  FINDINGS_WINDOW_DAYS,
  microsOf,
  runsWithRepeats,
  type DetectReads,
  type FindingDraft,
  type FrameClassPrice,
  type FrameClassPrices,
  type FrameContextPart,
  type FrameCoverage,
  type PricedRequestFrame,
  type RunCompaction,
  type RunFirstPrompt,
  type ToolCallObservation,
  type UnproductiveSpend,
} from "./findings";
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
  type PriceTokenClass,
} from "./price-book";
import type { OutcomeRow } from "./run-pr-outcomes";

const totals = schema.runTotals;
const sessions = schema.tachoSessions;
const findings = schema.findings;
const claims = schema.findingClaims;

/** Tool calls one pass reads, newest first; past this the tool-call window starts at the oldest call read. */
export const TOOL_CALL_READ_MAX = 200_000;
/**
 * Runs one pass reads model-call frames for: most repeats first, then the
 * dearest. A run past this cap has no frames, and `frameCoverage.capped`
 * counts it (ADR-208, ADR-210).
 */
export const FRAME_RUNS_READ_MAX = 200;
/** Model-call frame reads one pass runs at once. */
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
  /** Each named run's priced model-call frames in time order, by run public id. */
  readFrames: (
    scope: FindingsScope,
    runs: readonly FrameRead[],
  ) => Promise<Map<string, PricedRequestFrame[]>>;
  /** Per fingerprint, the latest decision on it. */
  readDecisions: (scope: FindingsScope) => Promise<Map<string, Date>>;
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
  write: (
    scope: FindingsScope,
    passStartedAt: Date,
    decidedSince: ReadonlyMap<string, Date>,
    drafts: readonly FindingDraft[],
  ) => Promise<number>;
}

/**
 * Where the tool-call window starts: the window's start, or the oldest call
 * read when the read hit its cap, so a finding never claims a stretch of the
 * window its calls were not read over.
 */
export function toolWindowStart(
  windowStart: Date,
  rows: readonly ToolCallObservationRow[],
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
      sessionUuid: r.sessionUuid === r.rootSessionUuid ? null : r.sessionUuid,
    });
  }
  return out;
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

/**
 * The runs a pass reads model-call frames for, and what the plan left out.
 * Every run in the window with a frame source is ranked: most repeats first,
 * then the dearest, then by run id. The first `limit` are read. `capped`
 * counts the ranked runs past the limit, and `unmatched` the runs with no
 * source, so a detector can tell a run with no frames from a run the pass did
 * not read (ADR-210).
 */
export function planFrameReads(
  runs: readonly RunTotalsRecord[],
  refs: ReadonlyMap<string, FrameRunRef>,
  repeatsByRun: ReadonlyMap<string, number>,
  limit: number,
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
  const reads = matched.slice(0, Math.max(0, limit));
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
  ]);
}

/**
 * One run's model-call frames, each priced once by the rollup's rule, in time
 * order to the microsecond. A frame's key is its `at` exactly as the store
 * printed it, then `#` and its place among the run's frames at that instant.
 * The store can return two frames of one instant in either order, so the
 * place follows each frame's content, chain included, and a frame keeps its
 * key from one pass to the next. Two frames with the same content on one
 * chain are interchangeable.
 *
 * Each frame names its chain as a tool call does: null on `rootSessionUuid`,
 * the chain's uuid otherwise, and absent when the row names none.
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
    .sort(
      (a, b) =>
        a.micros - b.micros ||
        (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
    );
  const atCount = new Map<string, number>();
  const partsByDigest = new Map<string, readonly FrameContextPart[]>();
  const out: PricedRequestFrame[] = [];
  for (const { row, micros } of ordered) {
    const n = atCount.get(row.at) ?? 0;
    atCount.set(row.at, n + 1);
    const frame = toModelCallFrame(row);
    const priced = priceFrame(book, orgId, frame);
    const t = frame.tokens;
    const digest = row.systemContextDigest ?? null;
    const listed = toContextParts(row);
    if (digest !== null && listed !== undefined)
      partsByDigest.set(digest, listed);
    out.push({
      key: `${row.at}#${n}`,
      at: frame.at,
      atMicros: micros,
      costMicros:
        priced.scaled === null
          ? null
          : divideHalfEven(priced.scaled, 1_000_000n),
      tokens:
        t.input_uncached +
        t.cache_read +
        t.cache_write_5m +
        t.cache_write_1h +
        t.output +
        t.reasoning,
      basis: priced.basis,
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
    });
  }
  return out;
}

async function readFrames(
  scope: FindingsScope,
  runs: readonly FrameRead[],
): Promise<Map<string, PricedRequestFrame[]>> {
  const read: { run: FrameRead; rows: ModelCallFrameRow[] }[] = [];
  for (let i = 0; i < runs.length; i += FRAME_READ_CONCURRENCY) {
    const batch = runs.slice(i, i + FRAME_READ_CONCURRENCY);
    const rows = await Promise.all(
      batch.map((r) => readModelCallFrames({ ...scope, run: r.ref })),
    );
    batch.forEach((run, j) => read.push({ run, rows: rows[j] ?? [] }));
  }
  const all = read.flatMap((r) => r.rows).map(toModelCallFrame);
  const book = await loadPriceBookSlice(runPriceSlice(scope.orgId, all));
  const classIndex = indexPriceBookByClass(book);
  const out = new Map<string, PricedRequestFrame[]>();
  for (const { run, rows } of read) {
    const root = run.ref.kind === "tacho" ? run.ref.rootSessionUuid : null;
    out.set(
      run.runId,
      pricedFrames(book, scope.orgId, rows, root, classIndex),
    );
  }
  return out;
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

async function readRuns(
  scope: FindingsScope,
  window: { start: Date; end: Date },
): Promise<RunTotalsRecord[]> {
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

/**
 * The unproductive spend headline over a window, and each operator's share
 * of it (ADR-208). It adds the frames that open and applied findings claim
 * and that ran in the window. A frame counts once, under the first detector
 * in counting order that claims it, so the operator totals sum to the
 * headline. A dismissed finding's claims do not count. The org and workspace
 * predicates hold on a tenant or a system transaction alike.
 */
export async function readUnproductiveSpend(
  tx: Tx,
  scope: FindingsScope,
  window: { start: Date; end: Date },
): Promise<UnproductiveSpend> {
  const rows = await tx
    .select({
      detector: claims.detector,
      runId: claims.runId,
      frameKey: claims.frameKey,
      operatorKey: claims.operatorKey,
      costMicros: claims.costMicros,
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
  return countClaims(rows);
}

const productionDeps: FindingsPassDeps = {
  now: () => new Date(),
  readRuns,
  readRootSessions,
  readToolCalls: readTachoToolCallObservations,
  readFrames,
  readDecisions,
  readRunRefs,
  readFirstPrompts,
  readFileChanges,
  readCompactions,
  readOutcomes,
  write: writeFindings,
};

/**
 * One findings pass over a workspace's trailing window: read the run rows,
 * the tool calls, and each run's first prompt, file changes, compactions, and
 * outcomes; read and price the model-call frames of up to
 * `FRAME_RUNS_READ_MAX` runs; detect; and replace the open findings and their
 * claims. Throws when a store is degraded: the job retries rather than
 * writing findings from missing frames.
 */
export async function runFindingsPass(
  scope: FindingsScope,
  deps: FindingsPassDeps = productionDeps,
): Promise<{ findings: number }> {
  const end = deps.now();
  const start = new Date(end.getTime() - FINDINGS_WINDOW_DAYS * DAY_MS);
  const [runs, runIdBySession, rows, decidedSince] = await Promise.all([
    deps.readRuns(scope, { start, end }),
    deps.readRootSessions(scope, start),
    deps.readToolCalls({
      ...scope,
      from: start,
      to: end,
      limit: TOOL_CALL_READ_MAX,
    }),
    deps.readDecisions(scope),
  ]);
  const runIds = new Set(runs.map((r) => r.runId));
  const toolCalls = toObservations(rows, runIdBySession).filter((c) =>
    runIds.has(c.runId),
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
  const { reads, coverage } = planFrameReads(
    runs,
    frameSources(runs, rows, runIdBySession, stored),
    runsWithRepeats(toolCalls),
    FRAME_RUNS_READ_MAX,
  );
  const frames =
    reads.length === 0
      ? new Map<string, PricedRequestFrame[]>()
      : await deps.readFrames(scope, reads);
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
    frameCoverage: coverage,
  };
  const drafts = detectFindings(input);
  return { findings: await deps.write(scope, end, decidedSince, drafts) };
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
