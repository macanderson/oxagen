/**
 * work-order-send-back.ts: the work orders whose runs keep ending with no
 * outcome (spend spec, detector 8, its second lever; F34, #5085).
 *
 * A send whose last `NO_OUTCOME_STREAK` runs each ended with nothing kept goes
 * back to its work item, with those runs and their spend attached.
 * `sendBackWorkOrders` in @oxagen/ingestion/collectors posts the note through
 * write-back. Nothing here starts a run or changes the work order.
 *
 * A run ended with nothing kept by detector 8's rule (`noOutcomeReason`):
 * every pull request it opened closed unmerged, or merged and was reverted
 * within `REVERT_WINDOW_DAYS`, or it opened none and was abandoned. A run whose
 * work landed breaks the streak. So does a run whose outcome is not read yet,
 * or whose pull request is still open, because its work may still land.
 *
 * Only a send (`work.orders`) can go back. A direct work order covers one run
 * (`work.direct_orders`), so it never has a streak of three. A send that has
 * closed is left out: its work item is already back with a person, and the
 * send gets no new run.
 *
 * Each run's work order comes from `cost.run_totals` (F13), and each run's
 * outcome from `cost.run_pr_outcomes` (F4, F25). The refresh keeps outcomes
 * for runs that started in the last `OUTCOME_WINDOW_DAYS`, so a streak is read
 * from those runs only.
 */
import { schema, withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { CostBasis } from "./cost-rollup";
import {
  type NoOutcomeReason,
  noOutcomeReason,
} from "./findings/spend-with-no-outcome";
import {
  OUTCOME_WINDOW_DAYS,
  type OutcomeRow,
  type OutcomeScope,
} from "./run-pr-outcomes";
import { readOutcomeRows } from "./run-pr-outcomes-store";

/**
 * A send goes back when this many of its runs in a row, newest first, ended
 * with nothing kept. The spec's detector 8 card leaves the count open; 3 is
 * F34's proposal.
 */
export const NO_OUTCOME_STREAK = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One run of a send, as `cost.run_totals` priced it. */
export interface SendBackRunTotal {
  runId: string;
  /** The send's `work.orders.id`. */
  workOrderId: string;
  /** The agent's key (`org_ns.ws_ns.slug`); null when the run named none. */
  agentKey: string | null;
  startedAt: Date;
  /** Null when the rollup priced no model call of the run. */
  costMicros: bigint | null;
  currency: string;
  costBasis: CostBasis | null;
}

/** An open send, with the work item it belongs to. */
export interface SendBackOrder {
  /** `work.orders.id`. */
  orderId: string;
  /** `wo_…`. */
  orderPublicId: string;
  /** `work.items.id`. */
  itemId: string;
}

/** What one run cost. */
export interface SendBackCost {
  micros: bigint;
  currency: string;
  basis: CostBasis;
}

/** One run of the streak. */
export interface SendBackRun {
  runId: string;
  startedAt: Date;
  /** Why the run's work did not land. */
  reason: NoOutcomeReason;
  /** Null when the rollup priced no model call of the run. */
  cost: SendBackCost | null;
}

/** A send to go back to its work item. */
export interface WorkOrderSendBack extends SendBackOrder {
  /** The agent's key on the streak's newest run; null when it named none. */
  agentKey: string | null;
  /** The streak's runs, newest first. Its first run identifies the streak. */
  runs: SendBackRun[];
}

const newestFirst = (a: SendBackRunTotal, b: SendBackRunTotal): number => {
  const delta = b.startedAt.getTime() - a.startedAt.getTime();
  if (delta !== 0) return delta;
  return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
};

/** The send's newest runs, at most `NO_OUTCOME_STREAK`. */
function streakOf(runs: readonly SendBackRunTotal[]): SendBackRunTotal[] {
  return [...runs].sort(newestFirst).slice(0, NO_OUTCOME_STREAK);
}

/**
 * The send-back for one send, from its runs and their outcome rows; null when
 * it has fewer than `NO_OUTCOME_STREAK` runs, or when any of its newest
 * `NO_OUTCOME_STREAK` runs did not end with nothing kept. A run with no
 * outcome row has no outcome read yet.
 */
export function workOrderSendBack(
  order: SendBackOrder,
  runs: readonly SendBackRunTotal[],
  outcomes: ReadonlyMap<string, readonly OutcomeRow[]>,
): WorkOrderSendBack | null {
  const streak = streakOf(runs.filter((run) => run.workOrderId === order.orderId));
  if (streak.length < NO_OUTCOME_STREAK) return null;
  const listed: SendBackRun[] = [];
  for (const run of streak) {
    const reason = noOutcomeReason(outcomes.get(run.runId) ?? []);
    if (reason === null) return null;
    listed.push({
      runId: run.runId,
      startedAt: run.startedAt,
      reason,
      cost:
        run.costMicros !== null && run.costBasis !== null
          ? { micros: run.costMicros, currency: run.currency, basis: run.costBasis }
          : null,
    });
  }
  return { ...order, agentKey: streak[0]!.agentKey, runs: listed };
}

/** The reads `findWorkOrderSendBacks` makes. Tests pass fakes. */
export interface SendBackDeps {
  /** The runs of sends that started in `[since, until)`. */
  readSendRuns: (scope: OutcomeScope, since: Date, until: Date) => Promise<SendBackRunTotal[]>;
  /** The open sends among `orderIds` whose work item is not deleted. */
  readOpenOrders: (scope: OutcomeScope, orderIds: readonly string[]) => Promise<SendBackOrder[]>;
  /** The outcome rows of the given runs. */
  readOutcomes: (scope: OutcomeScope, runIds: readonly string[]) => Promise<OutcomeRow[]>;
}

const totals = schema.runTotals;
const orders = schema.workOrders;
const items = schema.workItems;

async function readSendRuns(
  scope: OutcomeScope,
  since: Date,
  until: Date,
): Promise<SendBackRunTotal[]> {
  // tenancy: a scheduled pass outside a tenant scope; the read is filtered by orgId and workspaceId.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        runId: totals.runId,
        workOrderId: totals.workOrderId,
        agentKey: totals.agentKey,
        startedAt: totals.startedAt,
        costMicros: totals.costMicros,
        currency: totals.currency,
        costBasis: totals.costBasis,
      })
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          eq(totals.workOrderKind, "send"),
          isNotNull(totals.workOrderId),
          gte(totals.startedAt, since),
          lt(totals.startedAt, until),
        ),
      ),
  );
  return rows.flatMap((row) =>
    row.workOrderId === null
      ? []
      : [
          {
            runId: row.runId,
            workOrderId: row.workOrderId,
            agentKey: row.agentKey,
            startedAt: row.startedAt,
            costMicros: row.costMicros,
            currency: row.currency,
            costBasis: row.costBasis as CostBasis | null,
          },
        ],
  );
}

/** Run fn in the workspace's tenant scope, where the work records live. */
function inWorkspace<T>(scope: OutcomeScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTenantScope(
    { orgId: scope.orgId, workspaceId: scope.workspaceId },
    () => withTenantDb(fn),
  );
}

async function readOpenOrders(
  scope: OutcomeScope,
  orderIds: readonly string[],
): Promise<SendBackOrder[]> {
  if (orderIds.length === 0) return [];
  return inWorkspace(scope, (tx) =>
    tx
      .select({
        orderId: orders.id,
        orderPublicId: orders.publicId,
        itemId: orders.itemId,
      })
      .from(orders)
      .innerJoin(items, eq(items.id, orders.itemId))
      .where(
        and(
          eq(orders.orgId, scope.orgId),
          eq(orders.workspaceId, scope.workspaceId),
          inArray(orders.id, [...orderIds]),
          isNull(orders.closedAt),
          isNull(items.deletedAt),
        ),
      ),
  );
}

export const productionSendBackDeps: SendBackDeps = {
  readSendRuns,
  readOpenOrders,
  readOutcomes: readOutcomeRows,
};

/**
 * Every open send in the workspace whose last `NO_OUTCOME_STREAK` runs ended
 * with nothing kept, in public id order. It reads only runs that started in
 * the `OUTCOME_WINDOW_DAYS` before `now`.
 */
export async function findWorkOrderSendBacks(
  scope: OutcomeScope,
  now: Date,
  deps: SendBackDeps = productionSendBackDeps,
): Promise<WorkOrderSendBack[]> {
  const since = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS);
  const runs = await deps.readSendRuns(scope, since, now);
  const byOrder = new Map<string, SendBackRunTotal[]>();
  for (const run of runs) {
    const held = byOrder.get(run.workOrderId);
    if (held) held.push(run);
    else byOrder.set(run.workOrderId, [run]);
  }
  const candidates = [...byOrder.entries()]
    .filter(([, list]) => list.length >= NO_OUTCOME_STREAK)
    .map(([orderId]) => orderId);
  if (candidates.length === 0) return [];

  const open = await deps.readOpenOrders(scope, candidates);
  const streakRunIds = open.flatMap((order) =>
    streakOf(byOrder.get(order.orderId) ?? []).map((run) => run.runId),
  );
  if (streakRunIds.length === 0) return [];
  const outcomes = new Map<string, OutcomeRow[]>();
  for (const row of await deps.readOutcomes(scope, streakRunIds)) {
    const held = outcomes.get(row.runId);
    if (held) held.push(row);
    else outcomes.set(row.runId, [row]);
  }

  return open
    .flatMap((order) => {
      const found = workOrderSendBack(order, byOrder.get(order.orderId) ?? [], outcomes);
      return found === null ? [] : [found];
    })
    .sort((a, b) =>
      a.orderPublicId < b.orderPublicId ? -1 : a.orderPublicId > b.orderPublicId ? 1 : 0,
    );
}
