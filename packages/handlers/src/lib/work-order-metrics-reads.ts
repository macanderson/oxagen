// The reads behind the operator metrics, the work order metrics, and
// unassigned spend (spend spec, Operator productivity; F33). The fold is
// @oxagen/billing's work-order-metrics.ts. Every read runs in the caller's
// tenant scope and names the org and workspace too.
//
// - Runs: each run that may hold a frame in the range, with its work order
//   (F13): a send, a direct work order with its first run and attachment, or
//   none recorded. The frame bounds and the 30-day lookback are the
//   frame-time spend reader's (./frame-time-spend.ts), so both count the same
//   frames.
// - Segments: the frames of a run that crosses a week's edge, or the instant
//   its direct work order counts as assigned from, are read once from the
//   frame store and priced by the rollup's rule. At most
//   `CROSSING_RUNS_PRICED_MAX` runs are read, largest first. A run left
//   unread has no price for those segments, so a figure that needs it reads
//   null rather than part of its spend.
// - Work orders: each send closed in the range, or with a passing check run
//   in it, with its check runs, its runs, and when a person reopened its
//   work item or returned it.
// - Interrupts: from the frame store, per root session and week, mapped to
//   the run's public id.
import {
  assignedFrom,
  loadPriceBookSliceInTenantScope,
  type MetricCheckResult,
  type MetricOrder,
  type MetricRun,
  type MetricSpan,
  type ModelCallFrame,
  type PriceBook,
  type PricedSegment,
  runPriceSlice,
  runSegmentsToPrice,
  type RunWindowSpend,
  segmentKey,
  splitRunSpend,
  tokenTotal,
} from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import {
  captureError,
  chSelect,
  readModelCallFrames,
} from "@oxagen/telemetry";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  CROSSING_RUNS_PRICED_MAX,
  priceFramesIn,
  readRunRef,
  RUN_LOOKBACK_DAYS,
  toFrame,
} from "./frame-time-spend";

export type MetricsScope = { orgId: string; workspaceId: string };

const DAY_MS = 86_400_000;
/** Ids one `IN` list carries. */
const IN_CHUNK = 1_000;
/** Interrupt rows one read returns: one per root session and week. */
export const INTERRUPT_ROWS_MAX = 50_000;
/** Runs whose frames are read at once. */
const PRICE_CONCURRENCY = 8;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK)
    out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

const fromEpochMs = (value: string | number): Date => new Date(Number(value));

/**
 * The runs that may hold a frame in the range: started before its end and no
 * more than `RUN_LOOKBACK_DAYS` before its start, with a last frame bound at
 * or after its start. A run with no price is read too, since it is still an
 * open run for agents in flight. `operatorKeys` limits the read to those
 * operators; null reads every run.
 */
export async function readMetricRuns(
  scope: MetricsScope,
  range: MetricSpan,
  operatorKeys: readonly string[] | null,
): Promise<MetricRun[]> {
  if (operatorKeys !== null && operatorKeys.length === 0) return [];
  const totals = schema.runTotals;
  const direct = schema.workDirectOrders;
  const orders = schema.workOrders;
  const records = schema.workDoneRecords;
  // The latest instant a priced frame of the run can carry, as the frame-time
  // spend reader bounds it.
  const lastFrameBound = sql`least(coalesce(${totals.sealedAt}, ${totals.rolledUpAt}), ${totals.rolledUpAt})`;
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        runId: totals.runId,
        operatorKey: totals.operatorKey,
        agentKey: totals.agentKey,
        startedAt: totals.startedAt,
        lastFrameMs: sql<string>`(extract(epoch from ${lastFrameBound}) * 1000)::bigint::text`,
        costMicros: sql<string | null>`${totals.costMicros}::text`,
        currency: totals.currency,
        tokens: totals.tokens,
        workOrderKind: totals.workOrderKind,
        openedAt: direct.openedAt,
        attachedAt: direct.attachedAt,
        definitionOfDone: sql<boolean>`exists (select 1 from ${records} where ${records.itemId} = ${orders.itemId} and ${records.orgId} = ${totals.orgId} and ${records.workspaceId} = ${totals.workspaceId})`,
      })
      .from(totals)
      .leftJoin(
        direct,
        and(
          eq(totals.workOrderKind, "direct"),
          eq(direct.id, totals.workOrderId),
          eq(direct.orgId, totals.orgId),
          eq(direct.workspaceId, totals.workspaceId),
        ),
      )
      .leftJoin(
        orders,
        and(
          eq(totals.workOrderKind, "send"),
          eq(orders.id, totals.workOrderId),
          eq(orders.orgId, totals.orgId),
          eq(orders.workspaceId, totals.workspaceId),
        ),
      )
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(
            totals.startedAt,
            new Date(range.start.getTime() - RUN_LOOKBACK_DAYS * DAY_MS),
          ),
          lt(totals.startedAt, range.end),
          sql`${lastFrameBound} >= ${range.start.toISOString()}::timestamptz`,
          operatorKeys === null
            ? undefined
            : inArray(totals.operatorKey, [...operatorKeys]),
        ),
      ),
  );
  return rows.map((row): MetricRun => {
    let assignment: MetricRun["assignment"];
    if (row.workOrderKind === "send") assignment = { kind: "send" };
    else if (row.workOrderKind === "direct" && row.openedAt !== null)
      assignment = {
        kind: "direct",
        from: assignedFrom({
          openedAt: row.openedAt,
          attachedAt: row.attachedAt,
        }),
      };
    else assignment = { kind: "not_recorded" };
    return {
      runId: row.runId,
      operatorKey: row.operatorKey,
      agentKey: row.agentKey,
      startedAt: row.startedAt,
      lastFrameAt: fromEpochMs(row.lastFrameMs),
      costMicros: row.costMicros === null ? null : BigInt(row.costMicros),
      currency: row.currency,
      tokens: tokenTotal(row.tokens as Record<string, number> | null),
      assignment,
      definitionOfDone: row.workOrderKind === "send" && row.definitionOfDone,
    };
  });
}

/** Prices the listed segments of each run; `priceMetricSegments` in production. */
export type PriceMetricSegments = (
  scope: MetricsScope,
  requests: readonly {
    runId: string;
    costMicros: bigint;
    segments: readonly MetricSpan[];
  }[],
) => Promise<Map<string, PricedSegment | null>>;

/**
 * Each run's spend in each window by frame time, with its unassigned part.
 * Only the runs that cross a window's edge, or the instant their direct work
 * order counts as assigned from, have their frames read.
 */
export async function splitMetricSpend(
  price: PriceMetricSegments,
  scope: MetricsScope,
  runs: readonly MetricRun[],
  windows: readonly MetricSpan[],
): Promise<RunWindowSpend[][]> {
  const requests = runs.flatMap((run) => {
    const segments = runSegmentsToPrice(run, windows);
    return segments.length === 0 || run.costMicros === null
      ? []
      : [{ runId: run.runId, costMicros: run.costMicros, segments }];
  });
  const priced =
    requests.length === 0
      ? new Map<string, PricedSegment | null>()
      : await price(scope, requests);
  return splitRunSpend(runs, windows, priced);
}

/**
 * Price the frames of each run inside each of its segments. One frame read
 * per run. At most `CROSSING_RUNS_PRICED_MAX` runs are read, costliest
 * first; the rest, and any run whose read fails, have no price (null).
 */
export async function priceMetricSegments(
  scope: MetricsScope,
  requests: readonly {
    runId: string;
    costMicros: bigint;
    segments: readonly MetricSpan[];
  }[],
): Promise<Map<string, PricedSegment | null>> {
  const out = new Map<string, PricedSegment | null>();
  const ordered = [...requests]
    .filter((r) => r.segments.length > 0)
    .sort((a, b) =>
      a.costMicros !== b.costMicros
        ? a.costMicros > b.costMicros
          ? -1
          : 1
        : a.runId < b.runId
          ? -1
          : 1,
    );
  for (const left of ordered.slice(CROSSING_RUNS_PRICED_MAX))
    for (const span of left.segments) out.set(segmentKey(left.runId, span), null);
  const read = ordered.slice(0, CROSSING_RUNS_PRICED_MAX);
  for (let i = 0; i < read.length; i += PRICE_CONCURRENCY) {
    const batch = read.slice(i, i + PRICE_CONCURRENCY);
    const priced = await Promise.all(
      batch.map((req) =>
        priceRunSegments(scope, req.runId, req.segments).catch(
          (err: unknown) => {
            captureError({
              error: err,
              source: "api",
              severity: "warn",
              orgId: scope.orgId,
              workspaceId: scope.workspaceId,
              context: `work order metrics: run ${req.runId} left unpriced`,
            });
            return null;
          },
        ),
      ),
    );
    batch.forEach((req, j) => {
      const segments = priced[j] ?? null;
      req.segments.forEach((span, k) => {
        out.set(segmentKey(req.runId, span), segments?.[k] ?? null);
      });
    });
  }
  return out;
}

/**
 * The frames inside one span, priced the way the rollup prices a run
 * (`priceFramesIn`), with their tokens. A frame the book cannot price adds no
 * money and keeps its tokens, as it does on the run's own row.
 */
export function priceSegment(
  orgId: string,
  frames: readonly ModelCallFrame[],
  span: MetricSpan,
  book: PriceBook,
): PricedSegment {
  let tokens = 0;
  for (const frame of frames) {
    const at = frame.at.getTime();
    if (at < span.start.getTime() || at >= span.end.getTime()) continue;
    tokens += tokenTotal(frame.tokens);
  }
  return { micros: priceFramesIn(orgId, frames, span, book), tokens };
}

async function priceRunSegments(
  scope: MetricsScope,
  runId: string,
  segments: readonly MetricSpan[],
): Promise<(PricedSegment | null)[] | null> {
  const ref = await readRunRef(scope, runId);
  if (ref === null) return null;
  const frames = (await readModelCallFrames({ ...scope, run: ref })).map(
    toFrame,
  );
  if (frames.length === 0)
    return segments.map(() => ({ micros: 0n, tokens: 0 }));
  const book = await loadPriceBookSliceInTenantScope(
    runPriceSlice(scope.orgId, frames),
  );
  return segments.map((span) => priceSegment(scope.orgId, frames, span, book));
}

/**
 * The sends of the workspace closed in the range, or with a passing check
 * run in it, each with its check runs, its runs, and the times a person
 * reopened its work item or returned it.
 */
export async function readMetricOrders(
  scope: MetricsScope,
  range: MetricSpan,
): Promise<MetricOrder[]> {
  const orders = schema.workOrders;
  const checks = schema.workDoneChecks;
  const records = schema.workDoneRecords;
  const principals = schema.principals;
  const agents = schema.agents;
  const start = range.start.toISOString();
  const end = range.end.toISOString();

  return withTenantDb(async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        itemId: orders.itemId,
        operatorKey: principals.publicId,
        orgNamespace: schema.organizations.namespace,
        workspaceNamespace: schema.workspaces.namespace,
        agentSlug: agents.slug,
        dispatchedAt: orders.createdAt,
        closedAt: orders.closedAt,
        definitionOfDone: sql<boolean>`exists (select 1 from ${records} where ${records.itemId} = ${orders.itemId} and ${records.orgId} = ${orders.orgId} and ${records.workspaceId} = ${orders.workspaceId})`,
      })
      .from(orders)
      // The person who sent it, by the human principal that stands for them
      // in the org (operatorUserJoin's pair, read from the user's side).
      .leftJoin(
        principals,
        and(
          eq(principals.orgId, orders.orgId),
          eq(principals.parentUserId, orders.operatorId),
          eq(principals.kind, "human"),
        ),
      )
      .leftJoin(
        agents,
        and(eq(agents.id, orders.agentId), eq(agents.orgId, orders.orgId)),
      )
      .leftJoin(
        schema.workspaces,
        eq(schema.workspaces.id, agents.workspaceId),
      )
      .leftJoin(
        schema.organizations,
        eq(schema.organizations.id, agents.orgId),
      )
      .where(
        and(
          eq(orders.orgId, scope.orgId),
          eq(orders.workspaceId, scope.workspaceId),
          or(
            and(gte(orders.closedAt, range.start), lt(orders.closedAt, range.end)),
            sql`exists (select 1 from ${checks} where ${checks.orderId} = ${orders.id} and ${checks.orgId} = ${orders.orgId} and ${checks.workspaceId} = ${orders.workspaceId} and ${checks.result} = 'passed' and ${checks.checkedAt} >= ${start}::timestamptz and ${checks.checkedAt} < ${end}::timestamptz)`,
          ),
        ),
      );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const itemIds = [...new Set(rows.map((r) => r.itemId))];

    const checkRows: { orderId: string; checkedAt: Date; result: string }[] =
      [];
    const factRows: {
      itemId: string;
      orderId: string | null;
      kind: string;
      occurredAt: Date;
    }[] = [];
    const runRows: {
      workOrderId: string | null;
      runId: string;
      startedAt: Date;
      costMicros: string | null;
      currency: string;
    }[] = [];
    const facts = schema.workItemFacts;
    const totals = schema.runTotals;
    for (const part of chunks(ids)) {
      checkRows.push(
        ...(await tx
          .select({
            orderId: checks.orderId,
            checkedAt: checks.checkedAt,
            result: checks.result,
          })
          .from(checks)
          .where(
            and(
              eq(checks.orgId, scope.orgId),
              eq(checks.workspaceId, scope.workspaceId),
              inArray(checks.orderId, part),
            ),
          )),
      );
      runRows.push(
        ...(await tx
          .select({
            workOrderId: totals.workOrderId,
            runId: totals.runId,
            startedAt: totals.startedAt,
            costMicros: sql<string | null>`${totals.costMicros}::text`,
            currency: totals.currency,
          })
          .from(totals)
          .where(
            and(
              eq(totals.orgId, scope.orgId),
              eq(totals.workspaceId, scope.workspaceId),
              eq(totals.workOrderKind, "send"),
              inArray(totals.workOrderId, part),
            ),
          )),
      );
      factRows.push(
        ...(await tx
          .select({
            itemId: facts.itemId,
            orderId: facts.orderId,
            kind: facts.kind,
            occurredAt: facts.occurredAt,
          })
          .from(facts)
          .where(
            and(
              eq(facts.orgId, scope.orgId),
              eq(facts.workspaceId, scope.workspaceId),
              eq(facts.kind, "returned"),
              inArray(facts.orderId, part),
            ),
          )),
      );
    }
    for (const part of chunks(itemIds)) {
      factRows.push(
        ...(await tx
          .select({
            itemId: facts.itemId,
            orderId: facts.orderId,
            kind: facts.kind,
            occurredAt: facts.occurredAt,
          })
          .from(facts)
          .where(
            and(
              eq(facts.orgId, scope.orgId),
              eq(facts.workspaceId, scope.workspaceId),
              eq(facts.kind, "reopened"),
              inArray(facts.itemId, part),
            ),
          )),
      );
    }

    return rows.map((row): MetricOrder => {
      const rejections = factRows
        .filter((f) =>
          f.kind === "returned" ? f.orderId === row.id : f.itemId === row.itemId,
        )
        .map((f) => f.occurredAt);
      return {
        id: row.id,
        publicId: row.publicId,
        operatorKey: row.operatorKey,
        agentKey:
          row.orgNamespace && row.workspaceNamespace && row.agentSlug
            ? `${row.orgNamespace}.${row.workspaceNamespace}.${row.agentSlug}`
            : null,
        dispatchedAt: row.dispatchedAt,
        closedAt: row.closedAt,
        definitionOfDone: row.definitionOfDone,
        checks: checkRows
          .filter((c) => c.orderId === row.id)
          .map((c) => ({
            checkedAt: c.checkedAt,
            result: c.result as MetricCheckResult,
          })),
        rejections,
        runs: runRows
          .filter((r) => r.workOrderId === row.id)
          .map((r) => ({
            runId: r.runId,
            startedAt: r.startedAt,
            costMicros: r.costMicros === null ? null : BigInt(r.costMicros),
            currency: r.currency,
          })),
      };
    });
  });
}

/**
 * Interrupts per root session and week: the distinct messages a person's
 * prompt interrupted, from the `interrupted_message_id` tacho records on a
 * prompt. Only harnesses that report it count, so a ledger run counts none.
 */
export const INTERRUPTS_QUERY = `SELECT toString(root_session_uuid) AS root_session_uuid,
  toString(toMonday(ts)) AS week,
  uniqExact(interrupted_message_id) AS interrupts
  FROM tacho_events FINAL
  WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
    AND interrupted_message_id != ''
    AND ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}
    AND received_at >= {from:DateTime64(3)} - INTERVAL 1 DAY
  GROUP BY root_session_uuid, week
  LIMIT {limit:UInt32}`;

interface InterruptRow {
  root_session_uuid: string;
  week: string;
  interrupts: string | number;
}

function chDateTime(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

/** Interrupts per run public id and week (`YYYY-MM-DD`, the Monday). */
export async function readRunInterrupts(
  scope: MetricsScope,
  range: MetricSpan,
): Promise<Map<string, Map<string, number>>> {
  const result = await chSelect<InterruptRow>({
    query: INTERRUPTS_QUERY,
    params: {
      from: chDateTime(range.start),
      to: chDateTime(range.end),
      limit: INTERRUPT_ROWS_MAX,
    },
  });
  const rows = result.data;
  const out = new Map<string, Map<string, number>>();
  if (rows.length === 0) return out;
  const roots = [...new Set(rows.map((r) => r.root_session_uuid))];
  const sessions = schema.tachoSessions;
  const publicIds = new Map<string, string>();
  await withTenantDb(async (tx) => {
    for (const part of chunks(roots)) {
      const found = await tx
        .select({ uuid: sessions.sessionUuid, publicId: sessions.publicId })
        .from(sessions)
        .where(
          and(
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            inArray(sessions.sessionUuid, part),
            isNull(sessions.parentSessionUuid),
          ),
        );
      for (const row of found) publicIds.set(row.uuid, row.publicId);
    }
  });
  for (const row of rows) {
    const runId = publicIds.get(row.root_session_uuid);
    if (runId === undefined) continue;
    const weeks = out.get(runId) ?? new Map<string, number>();
    weeks.set(row.week, (weeks.get(row.week) ?? 0) + Number(row.interrupts));
    out.set(runId, weeks);
  }
  return out;
}
