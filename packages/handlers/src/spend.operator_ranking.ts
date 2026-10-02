// audit-exempt: read-only — ranks operators by the claimed frames in cost.finding_claims, with each operator's priced spend from cost.run_totals and the frame store and the pseudonym setting from workspace.operator_ranking_policy; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_operator_ranking` (spend spec, Operator ranking; D15): the operators
// of the workspace ranked by unproductive spend, highest first. The figures
// come from the same claim rows as the headline (`readUnproductiveClaims`,
// ADR-208) and the same count (`countClaims`), so each frame counts once and
// the operator totals and the unattributed total sum to the headline. A run's
// figure is `countClaims` over that run's rows. The dedupe key holds the run
// id, so the run figures partition the headline too.
//
// The unproductive share divides an operator's claimed frames by the priced
// spend of the frames that operator's runs ran in the period. Both sides
// count a frame by the time it ran (./lib/frame-time-spend.ts), so a run that
// crosses the period's first or last day adds the same frames to each.
//
// Managers read it: an org Owner or Admin. The kernel's IAM check admits the
// same two roles in an Enterprise org, and no person holds a workspace IAM
// role yet (#3198), so the ranking names no workspace role. With the
// pseudonym setting on, a pseudonym replaces each name, and the answer drops
// the key, the facts, and the run ids, since a run page names its operator.
// It also drops the unproductive share and the run count: the share gives
// back the operator's priced spend, and `get_spend` names each operator
// beside that spend and its runs.
//
// A period whose claims hold two currencies is refused. `countClaims` sums
// micros, and a sum of dollars and euros is no figure.
//
// Beside each name are its done work orders and its unassigned share (F33).
// A work order is done at its first passing check run of its definition of
// done (decision 5), and counts in the period that check fell in. The
// unassigned share divides the spend on the operator's runs whose direct
// work order has no work item, with the 24-hour grace window (decision 4),
// by the operator's spend, both counted by frame time. Unassigned spend
// never adds to the unproductive figures (decision 3). Under pseudonyms the
// done count stays, and the share and the evidence behind both are dropped.
// The unassigned share takes its spend from the same split as its unassigned
// part (./lib/work-order-metrics-reads.ts), so a run left unpriced nulls both
// sides together. That spend equals the unproductive share's whole whenever
// neither read left a run unpriced.
import {
  countClaims,
  dayBounds,
  doneWorkOrders,
  type MetricOrder,
  type MetricRun,
  readUnproductiveClaims,
  type RunWindowSpend,
  shareOf as shareOfSpend,
  sumRunSpend,
  type UnproductiveClaim,
} from "@oxagen/billing";
import { withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import type { OperatorFacts } from "@oxagen/oxagen/contracts/operator.shared";
import {
  OPERATOR_RANKING_RUNS_MAX,
  type OperatorRankingRow,
  spendOperatorRanking,
  type SpendOperatorRankingOutput,
} from "@oxagen/oxagen/contracts/spend.operator_ranking";
import {
  type FrameTimeSpendResult,
  frameTimeSpendDeps,
  readFrameTimeSpend,
} from "./lib/frame-time-spend";
import { readOperatorFacts, type ReadOperatorFacts } from "./lib/operator-facts";
import {
  type PriceMetricSegments,
  priceMetricSegments,
  readMetricOrders,
  readMetricRuns,
  splitMetricSpend,
} from "./lib/work-order-metrics-reads";
import {
  operatorPseudonym,
  type PseudonymPolicy,
  readPseudonymPolicy,
} from "./lib/operator-pseudonyms";

export type RankingScope = { orgId: string; workspaceId: string };
type Window = { start: Date; end: Date };

export type OperatorRankingDeps = {
  readClaims: (
    scope: RankingScope,
    window: Window,
  ) => Promise<UnproductiveClaim[]>;
  /**
   * The priced spend of the frames the named operators' runs ran in the
   * window, per operator and currency (./lib/frame-time-spend.ts).
   */
  readOperatorSpend: (
    scope: RankingScope,
    window: Window,
    operatorKeys: readonly string[],
  ) => Promise<FrameTimeSpendResult>;
  readOperatorFacts: ReadOperatorFacts;
  readPolicy: (scope: RankingScope) => Promise<PseudonymPolicy>;
  /** The named operators' runs that may hold a frame in the window, with their work orders. */
  readRuns: (
    scope: RankingScope,
    window: Window,
    operatorKeys: readonly string[],
  ) => Promise<MetricRun[]>;
  /** Prices the frames of the runs that cross the window's edge or their assignment. */
  priceSegments: PriceMetricSegments;
  /** The sends closed in the window or with a passing check run in it. */
  readOrders: (scope: RankingScope, window: Window) => Promise<MetricOrder[]>;
};

/** Who may read the ranking: the roles the contract's defaultRoles allow. */
export const RANKING_ROLES = { org: ["Owner", "Admin"] } as const;

async function readClaims(
  scope: RankingScope,
  window: Window,
): Promise<UnproductiveClaim[]> {
  return withTenantDb((tx) => readUnproductiveClaims(tx, scope, window));
}

function readOperatorSpend(
  scope: RankingScope,
  window: Window,
  operatorKeys: readonly string[],
): Promise<FrameTimeSpendResult> {
  return readFrameTimeSpend(frameTimeSpendDeps, scope, window, operatorKeys);
}

const byMicrosDesc = (
  a: { micros: bigint; id: string },
  b: { micros: bigint; id: string },
): number =>
  a.micros !== b.micros
    ? a.micros > b.micros
      ? -1
      : 1
    : a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0;

/** A ratio of two micros amounts, capped at 1; null when the whole is not positive. */
function ratio(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  return Math.min(1, Number(part) / Number(whole));
}

/**
 * Each operator's runs with the micros counted under that operator in each.
 * `countClaims` over one run's rows keeps the headline's dedupe, and a run
 * whose frames name two operators splits between them the same way.
 */
export function runsByOperator(
  rows: readonly UnproductiveClaim[],
): Map<string | null, Map<string, bigint>> {
  const byRun = new Map<string, UnproductiveClaim[]>();
  for (const row of rows) {
    const held = byRun.get(row.runId);
    if (held) held.push(row);
    else byRun.set(row.runId, [row]);
  }
  const out = new Map<string | null, Map<string, bigint>>();
  for (const [runId, runRows] of byRun) {
    for (const { operatorKey, micros } of countClaims(runRows).operators) {
      const runs = out.get(operatorKey) ?? new Map<string, bigint>();
      runs.set(runId, (runs.get(runId) ?? 0n) + micros);
      out.set(operatorKey, runs);
    }
  }
  return out;
}

export function createOperatorRankingHandler(
  deps: OperatorRankingDeps,
): CapabilityHandler<typeof spendOperatorRanking> {
  return async (input, ctx): Promise<SpendOperatorRankingOutput> => {
    const userId = await resolveActingUserId(ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    await assertOrgRole({ ...ctx, userId }, { org: [...RANKING_ROLES.org] });
    const { from, to } = input.period;
    const window = { start: dayBounds(from).start, end: dayBounds(to).next };

    const [claims, policy] = await Promise.all([
      deps.readClaims(scope, window),
      deps.readPolicy(scope),
    ]);
    const currencies = [...new Set(claims.map((c) => c.currency))].sort();
    if (currencies.length > 1) {
      throw new HandlerError({
        code: "conflict",
        reason: "ranking_mixed_currency",
        message: `The period holds unproductive spend priced in ${currencies.join(" and in ")}. The ranking sums one currency, so no ranking was built.`,
      });
    }
    const headline = countClaims(claims);
    const currency = currencies[0] ?? "USD";
    const money = (micros: bigint) => ({ micros: micros.toString(), currency });
    const runs = runsByOperator(claims);
    const pseudonyms = policy.pseudonyms && policy.salt !== null;

    const named = headline.operators.flatMap((o) =>
      o.operatorKey === null ? [] : [{ key: o.operatorKey, micros: o.micros }],
    );
    const keys = named.map((o) => o.key);
    const [spend, facts, metricRuns, orders] = await Promise.all([
      pseudonyms || keys.length === 0
        ? Promise.resolve<FrameTimeSpendResult>({ rows: [], partial: new Set() })
        : deps.readOperatorSpend(scope, window, keys),
      pseudonyms || keys.length === 0
        ? Promise.resolve(new Map<string, OperatorFacts>())
        : deps.readOperatorFacts(scope, keys),
      pseudonyms || keys.length === 0
        ? Promise.resolve<MetricRun[]>([])
        : deps.readRuns(scope, window, keys),
      keys.length === 0
        ? Promise.resolve<MetricOrder[]>([])
        : deps.readOrders(scope, window),
    ]);
    // Each named operator's spend in the window and its unassigned part, by
    // frame time. Read only when the share is shown.
    const assignment: RunWindowSpend[] =
      metricRuns.length === 0
        ? []
        : ((
            await splitMetricSpend(deps.priceSegments, scope, metricRuns, [
              window,
            ])
          )[0] ?? []);
    // An operator whose priced spend holds another currency has no share: the
    // part is in one currency and the whole would be in two. Nor has one
    // whose spend misses a run the frame store did not price.
    const spendOf = new Map<string, bigint | null>();
    for (const s of spend.rows) {
      if (s.operatorKey === null) continue;
      const held = spendOf.get(s.operatorKey);
      if (s.currency !== currency || held === null) {
        spendOf.set(s.operatorKey, null);
      } else {
        spendOf.set(s.operatorKey, (held ?? 0n) + s.micros);
      }
    }
    for (const key of spend.partial)
      if (key !== null) spendOf.set(key, null);

    const unproductiveShareOf = (micros: bigint, key: string): number | null => {
      const whole = spendOf.get(key);
      return whole === null || whole === undefined ? null : ratio(micros, whole);
    };

    const operators = named.map((o, i): OperatorRankingRow => {
      const own = runs.get(o.key) ?? new Map<string, bigint>();
      const topRuns = pseudonyms
        ? []
        : [...own]
            .map(([id, micros]) => ({ id, micros }))
            .sort(byMicrosDesc)
            .slice(0, OPERATOR_RANKING_RUNS_MAX)
            .map((r) => ({ runId: r.id, unproductive: money(r.micros) }));
      const done = doneWorkOrders(
        orders.filter((order) => order.operatorKey === o.key),
        window,
      );
      const assigned = sumRunSpend(
        assignment.filter((r) => r.operatorKey === o.key),
        currency,
      );
      return {
        rank: i + 1,
        operator: pseudonyms
          ? {
              kind: "pseudonym",
              pseudonym: operatorPseudonym(policy.salt as string, o.key),
            }
          : { kind: "named", key: o.key, facts: facts.get(o.key) ?? null },
        unproductive: money(o.micros),
        shareOfTotal: ratio(o.micros, headline.totalMicros) ?? 0,
        unproductiveShare: pseudonyms ? null : unproductiveShareOf(o.micros, o.key),
        runs: pseudonyms ? null : own.size,
        topRuns,
        doneWorkOrders: done.length,
        topDoneWorkOrders: pseudonyms
          ? []
          : done.slice(0, OPERATOR_RANKING_RUNS_MAX).map((d) => ({
              workOrderId: d.order.publicId,
              doneAt: d.doneAt.toISOString(),
              runs: d.order.runs
                .map((r) => r.runId)
                .sort()
                .slice(0, OPERATOR_RANKING_RUNS_MAX),
            })),
        unassignedShare: pseudonyms
          ? null
          : shareOfSpend(assigned.unassigned, assigned.spend),
        topUnassignedRuns: pseudonyms
          ? []
          : assigned.unassignedRuns
              .slice(0, OPERATOR_RANKING_RUNS_MAX)
              .map((r) => ({ runId: r.runId, unassigned: money(r.micros) })),
      };
    });

    const unattributed = headline.operators.find((o) => o.operatorKey === null);
    return {
      period: { from, to },
      pseudonyms,
      unproductive: money(headline.totalMicros),
      unattributed: {
        unproductive: money(unattributed?.micros ?? 0n),
        runs: runs.get(null)?.size ?? 0,
      },
      operators,
    };
  };
}

export const spendOperatorRankingHandler = createOperatorRankingHandler({
  readClaims,
  readOperatorSpend,
  readOperatorFacts,
  readPolicy: readPseudonymPolicy,
  readRuns: readMetricRuns,
  priceSegments: priceMetricSegments,
  readOrders: readMetricOrders,
});
