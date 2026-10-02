// audit-exempt: read-only — reports the operator and work order metrics and unassigned spend from cost.run_totals, cost.finding_claims, the work records (work.orders, work.direct_orders, work.done_checks, work.item_facts), and the frame store; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_work_order_metrics` (spend spec, Operator productivity; F33): per
// week, the seven operator metrics, the seven work order metrics, and
// unassigned spend. @oxagen/billing's work-order-metrics.ts holds the fold
// and the rules: done at the first passing check run (decision 5), the
// 24-hour grace window for a direct work order (decision 4), and unassigned
// spend kept out of unproductive spend (decision 3).
//
// Each week's unproductive spend is the headline's count for that week:
// the claims `readUnproductiveClaims` returns, counted by `countClaims`.
// Unassigned spend is reported beside it and never added to it.
//
// The answer names operators, so its readers are the ranking's org roles:
// an org Owner or Admin. The ranking also admits the workspace's Owner
// (#5182), and this answer does not. With the pseudonym setting on, a pseudonym replaces each
// name, and each operator row drops its evidence, both shares, its agents,
// and its unassigned spend and tokens. Any of those could match a
// pseudonym to a name on a page that names operators.
import {
  agentsInFlight,
  countClaims,
  doneWorkOrders,
  type MetricEvidence,
  type MetricOrder,
  type MetricRun,
  type MetricSpan,
  readUnproductiveClaims,
  type RunWindowSpend,
  shareOf,
  type SpendSum,
  sumRunSpend,
  type UnproductiveClaim,
  weekSettled,
  weeksOverlapping,
  workOrderMetrics,
  type WorkOrderMetricsFold,
} from "@oxagen/billing";
import { withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import type { OperatorFacts } from "@oxagen/oxagen/contracts/operator.shared";
import {
  OPERATOR_METRIC_DEFINITIONS,
  type OperatorMetrics,
  spendWorkOrderMetrics,
  type SpendWorkOrderMetricsOutput,
  UNASSIGNED_SPEND_DEFINITION,
  type UnassignedLine,
  WORK_ORDER_METRIC_DEFINITIONS,
  WORK_ORDER_METRICS_EVIDENCE_MAX,
  type WorkOrderMetrics,
  type WorkOrderMetricsWeek,
} from "@oxagen/oxagen/contracts/spend.work_order_metrics";
import { readOperatorFacts, type ReadOperatorFacts } from "./lib/operator-facts";
import {
  operatorPseudonym,
  type PseudonymPolicy,
  readPseudonymPolicy,
} from "./lib/operator-pseudonyms";
import {
  type MetricsScope,
  type PriceMetricSegments,
  priceMetricSegments,
  readMetricOrders,
  readMetricRuns,
  readRunInterrupts,
  splitMetricSpend,
} from "./lib/work-order-metrics-reads";
import { RANKING_ROLES, runsByOperator } from "./spend.operator_ranking";

export type WorkOrderMetricsDeps = {
  now: () => Date;
  readClaims: (
    scope: MetricsScope,
    window: MetricSpan,
  ) => Promise<UnproductiveClaim[]>;
  readRuns: (
    scope: MetricsScope,
    range: MetricSpan,
    operatorKeys: readonly string[] | null,
  ) => Promise<MetricRun[]>;
  priceSegments: PriceMetricSegments;
  readOrders: (scope: MetricsScope, range: MetricSpan) => Promise<MetricOrder[]>;
  /** Interrupts per run public id and week (the Monday, `YYYY-MM-DD`). */
  readInterrupts: (
    scope: MetricsScope,
    range: MetricSpan,
  ) => Promise<Map<string, Map<string, number>>>;
  readOperatorFacts: ReadOperatorFacts;
  readPolicy: (scope: MetricsScope) => Promise<PseudonymPolicy>;
};

const cap = <T>(items: readonly T[]): T[] =>
  items.slice(0, WORK_ORDER_METRICS_EVIDENCE_MAX);

/** Round half up; spend is never negative. */
function perDone(micros: bigint, done: number): bigint {
  const n = BigInt(done);
  return (micros * 2n + n) / (2n * n);
}

function sortedIds(ids: Iterable<string>): string[] {
  return cap([...new Set(ids)].sort());
}

/** The figures and evidence one answer builds, in its one currency. */
class Figures {
  constructor(
    private readonly currency: string,
    private readonly now: Date,
  ) {}

  money(micros: bigint) {
    return { micros: micros.toString(), currency: this.currency };
  }

  moneyOrNull(micros: bigint | null) {
    return micros === null ? null : this.money(micros);
  }

  workOrders(
    orders: readonly MetricOrder[],
    week: MetricSpan,
    hide: boolean,
  ): WorkOrderMetrics {
    const fold: WorkOrderMetricsFold = workOrderMetrics(
      orders,
      week,
      this.currency,
      this.now,
    );
    const ev = (e: MetricEvidence) =>
      hide
        ? { workOrders: [], runs: [] }
        : { workOrders: cap(e.workOrders), runs: cap(e.runs) };
    const rate = (r: WorkOrderMetricsFold["doneRate"]) => ({
      value: r.value,
      numerator: r.numerator,
      denominator: r.denominator,
      ...ev(r),
    });
    return {
      done: fold.done,
      doneRate: rate(fold.doneRate),
      firstPassRate: rate(fold.firstPassRate),
      costToDone: {
        value: this.moneyOrNull(fold.costToDone.micros),
        ...ev(fold.costToDone),
      },
      timeToDone: {
        valueMs: fold.timeToDone.ms === null ? null : Math.max(0, fold.timeToDone.ms),
        ...ev(fold.timeToDone),
      },
      reworkSpend: {
        value: this.moneyOrNull(fold.reworkSpend.micros),
        ...ev(fold.reworkSpend),
      },
      abandonedSpend: {
        value: this.moneyOrNull(fold.abandonedSpend.micros),
        ...ev(fold.abandonedSpend),
      },
      reopenRate: { ...rate(fold.reopenRate), pending: fold.reopenRate.pending },
    };
  }

  unassigned(sum: SpendSum, hide: boolean): UnassignedLine {
    if (hide) return { spend: null, tokens: null, share: null, runs: [] };
    return {
      spend: this.moneyOrNull(sum.unassigned),
      tokens: sum.unassignedTokens,
      share: shareOf(sum.unassigned, sum.spend),
      runs: sum.unassignedRuns.map((r) => ({
        runId: r.runId,
        unassigned: this.money(r.micros),
      })),
    };
  }
}

/** Whether a run was open at any instant of the week. */
function openIn(run: MetricRun, week: MetricSpan): boolean {
  return (
    run.startedAt.getTime() < week.end.getTime() &&
    run.lastFrameAt.getTime() >= week.start.getTime()
  );
}

/** Whether the week saw the work order done or closed. */
function activeIn(order: MetricOrder, week: MetricSpan): boolean {
  const inWeek = (at: Date | null) =>
    at !== null &&
    at.getTime() >= week.start.getTime() &&
    at.getTime() < week.end.getTime();
  return (
    inWeek(order.closedAt) ||
    order.checks.some((c) => c.result === "passed" && inWeek(c.checkedAt))
  );
}

/** The single currency of every figure; more than one refuses the read. */
function oneCurrency(
  claims: readonly UnproductiveClaim[][],
  runs: readonly MetricRun[],
  orders: readonly MetricOrder[],
): string {
  const currencies = new Set<string>();
  for (const week of claims) for (const c of week) currencies.add(c.currency);
  for (const run of runs)
    if (run.costMicros !== null) currencies.add(run.currency);
  for (const order of orders)
    for (const run of order.runs)
      if (run.costMicros !== null) currencies.add(run.currency);
  const sorted = [...currencies].sort();
  if (sorted.length > 1) {
    throw new HandlerError({
      code: "conflict",
      reason: "work_order_metrics_mixed_currency",
      message: `The period holds spend priced in ${sorted.join(" and in ")}. Each figure sums one currency, so none was built. Ask for a shorter period that holds one currency.`,
    });
  }
  return sorted[0] ?? "USD";
}

export function createWorkOrderMetricsHandler(
  deps: WorkOrderMetricsDeps,
): CapabilityHandler<typeof spendWorkOrderMetrics> {
  return async (input, ctx): Promise<SpendWorkOrderMetricsOutput> => {
    const userId = await resolveActingUserId(ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    await assertOrgRole({ ...ctx, userId }, { org: [...RANKING_ROLES.org] });
    const { from, to } = input.period;
    const weeks = weeksOverlapping(from, to);
    const first = weeks[0];
    const last = weeks[weeks.length - 1];
    if (first === undefined || last === undefined)
      throw new RangeError(`no week overlaps ${from} to ${to}`);
    const range = { start: first.start, end: last.end };
    const now = deps.now();

    const [runs, orders, interrupts, policy] = await Promise.all([
      deps.readRuns(scope, range, null),
      deps.readOrders(scope, range),
      deps.readInterrupts(scope, range),
      deps.readPolicy(scope),
    ]);
    const claimsByWeek: UnproductiveClaim[][] = [];
    for (const week of weeks)
      claimsByWeek.push(await deps.readClaims(scope, week));
    const currency = oneCurrency(claimsByWeek, runs, orders);
    const split = await splitMetricSpend(
      deps.priceSegments,
      scope,
      runs,
      weeks,
    );
    const hide = policy.pseudonyms && policy.salt !== null;
    const figures = new Figures(currency, now);

    // Every operator the answer names, for one facts read.
    const operatorKeys = new Set<string>();
    for (const run of runs) if (run.operatorKey) operatorKeys.add(run.operatorKey);
    for (const order of orders)
      if (order.operatorKey) operatorKeys.add(order.operatorKey);
    const facts =
      hide || operatorKeys.size === 0
        ? new Map<string, OperatorFacts>()
        : await deps.readOperatorFacts(scope, [...operatorKeys]);

    const out: WorkOrderMetricsWeek[] = weeks.map((week, i) => {
      const rows: RunWindowSpend[] = split[i] ?? [];
      const claims = claimsByWeek[i] ?? [];
      const counted = countClaims(claims);
      const claimRuns = runsByOperator(claims);
      const all = sumRunSpend(rows, currency);
      const weekRuns = runs.filter((r) => openIn(r, week));
      const weekOrders = orders.filter((o) => activeIn(o, week));

      const keys = new Set<string>();
      for (const row of rows) if (row.operatorKey) keys.add(row.operatorKey);
      for (const run of weekRuns) if (run.operatorKey) keys.add(run.operatorKey);
      for (const order of weekOrders)
        if (order.operatorKey) keys.add(order.operatorKey);
      for (const o of counted.operators)
        if (o.operatorKey) keys.add(o.operatorKey);

      const operators = [...keys].map((key) => {
        const sum = sumRunSpend(
          rows.filter((r) => r.operatorKey === key),
          currency,
        );
        const own = orders.filter((o) => o.operatorKey === key);
        const done = doneWorkOrders(own, week);
        const doneIds = done.map((d) => d.order.publicId);
        const doneRuns = done.flatMap((d) => d.order.runs.map((r) => r.runId));
        const unproductive =
          counted.operators.find((o) => o.operatorKey === key)?.micros ?? 0n;
        const unproductiveRuns = [...(claimRuns.get(key) ?? new Map<string, bigint>())]
          .sort((a, b) => (a[1] !== b[1] ? (a[1] > b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
          .map(([runId]) => runId);
        const inFlight = agentsInFlight(
          runs.filter((r) => r.operatorKey === key),
          week,
          now,
        );
        let touches = 0;
        const touchRuns: string[] = [];
        for (const run of weekRuns) {
          if (run.operatorKey !== key) continue;
          const n = interrupts.get(run.runId)?.get(week.from) ?? 0;
          if (n > 0) {
            touches += n;
            touchRuns.push(run.runId);
          }
        }
        const dodRuns = rows
          .filter(
            (r) =>
              r.operatorKey === key &&
              r.definitionOfDone !== null &&
              r.definitionOfDone > 0n,
          )
          .map((r) => r.runId);
        const metrics: OperatorMetrics = {
          doneWorkOrders: {
            value: done.length,
            workOrders: hide ? [] : sortedIds(doneIds),
            runs: hide ? [] : sortedIds(doneRuns),
          },
          costPerDone: {
            value:
              done.length === 0 || sum.definitionOfDone === null
                ? null
                : figures.money(perDone(sum.definitionOfDone, done.length)),
            workOrders: hide ? [] : sortedIds(doneIds),
            runs: hide ? [] : sortedIds(dodRuns),
          },
          unproductiveShare: {
            value: hide ? null : shareOf(unproductive, sum.spend),
            runs: hide ? [] : cap(unproductiveRuns),
          },
          agentsInFlight: {
            value: inFlight.average,
            agents: hide ? [] : cap(inFlight.agents),
          },
          leverage: {
            value: inFlight.average > 0 ? done.length / inFlight.average : null,
          },
          touchesPerDone: {
            value: done.length === 0 ? null : touches / done.length,
            touches,
            basis: "interrupts",
            runs: hide ? [] : sortedIds(touchRuns),
          },
          unassignedShare: {
            value: hide ? null : shareOf(sum.unassigned, sum.spend),
            runs: hide ? [] : cap(sum.unassignedRuns.map((r) => r.runId)),
          },
        };
        return {
          key,
          row: {
            operator: hide
              ? {
                  kind: "pseudonym" as const,
                  pseudonym: operatorPseudonym(policy.salt as string, key),
                }
              : {
                  kind: "named" as const,
                  key,
                  facts: facts.get(key) ?? null,
                },
            metrics,
            unassigned: figures.unassigned(sum, hide),
            workOrders: figures.workOrders(own, week, hide),
          },
        };
      });
      // A stable order that ranks nobody: by key, or by pseudonym.
      operators.sort((a, b) => {
        const ka = a.row.operator.kind === "pseudonym" ? a.row.operator.pseudonym : a.key;
        const kb = b.row.operator.kind === "pseudonym" ? b.row.operator.pseudonym : b.key;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });

      const agentKeys = new Set<string>();
      for (const row of rows) if (row.agentKey) agentKeys.add(row.agentKey);
      for (const order of weekOrders)
        if (order.agentKey) agentKeys.add(order.agentKey);
      const agents = [...agentKeys].sort().map((agentKey) => ({
        agentKey,
        unassigned: figures.unassigned(
          sumRunSpend(
            rows.filter((r) => r.agentKey === agentKey),
            currency,
          ),
          false,
        ),
        workOrders: figures.workOrders(
          orders.filter((o) => o.agentKey === agentKey),
          week,
          false,
        ),
      }));

      return {
        week: { from: week.from, to: week.to },
        settled: weekSettled(week, now),
        workspace: {
          spend: figures.moneyOrNull(all.spend),
          // The headline's count for the week. Unassigned spend is reported
          // beside it and never added to it (decision 3).
          unproductive: figures.money(counted.totalMicros),
          unassigned: figures.unassigned(all, false),
          notRecorded: figures.moneyOrNull(all.notRecorded),
          workOrders: figures.workOrders(orders, week, false),
        },
        operators: operators.map((o) => o.row),
        agents,
      };
    });

    return {
      period: { from, to },
      pseudonyms: hide,
      currency,
      definitions: {
        operator: [...OPERATOR_METRIC_DEFINITIONS],
        workOrder: [...WORK_ORDER_METRIC_DEFINITIONS],
        unassigned: UNASSIGNED_SPEND_DEFINITION,
      },
      weeks: out,
    };
  };
}

export const spendWorkOrderMetricsHandler = createWorkOrderMetricsHandler({
  now: () => new Date(),
  readClaims: (scope, window) =>
    withTenantDb((tx) => readUnproductiveClaims(tx, scope, window)),
  readRuns: readMetricRuns,
  priceSegments: priceMetricSegments,
  readOrders: readMetricOrders,
  readInterrupts: readRunInterrupts,
  readOperatorFacts,
  readPolicy: readPseudonymPolicy,
});
