// audit-exempt: read-only — ranks operators by the claimed frames in cost.finding_claims, with each operator's priced spend from cost.run_totals and the pseudonym setting from workspace.operator_ranking_policy; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_operator_ranking` (spend spec, Operator ranking; D15): the operators
// of the workspace ranked by unproductive spend, highest first. The figures
// come from the same claim rows as the headline (`readUnproductiveClaims`,
// ADR-208) and the same count (`countClaims`), so each frame counts once and
// the operator totals and the unattributed total sum to the headline. A run's
// figure is `countClaims` over that run's rows. The dedupe key holds the run
// id, so the run figures partition the headline too.
//
// Managers read it: an org Owner or Admin, or the workspace's Owner. No person
// holds a workspace IAM role yet (#3198), so the workspace Owner is read from
// the membership row when the IAM check refuses. With the
// pseudonym setting on, a pseudonym replaces each name, and the answer drops
// the key, the facts, and the run ids, since a run page names its operator.
// It also drops the unproductive share and the run count: the share gives
// back the operator's priced spend, and `get_spend` names each operator
// beside that spend and its runs.
//
// A period whose claims hold two currencies is refused. `countClaims` sums
// micros, and a sum of dollars and euros is no figure.
import {
  countClaims,
  dayBounds,
  readUnproductiveClaims,
  type UnproductiveClaim,
} from "@oxagen/billing";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  type CapabilityHandler,
  HandlerError,
  isHandlerError,
} from "@oxagen/oxagen";
import type { OperatorFacts } from "@oxagen/oxagen/contracts/operator.shared";
import {
  OPERATOR_RANKING_RUNS_MAX,
  type OperatorRankingRow,
  spendOperatorRanking,
  type SpendOperatorRankingOutput,
} from "@oxagen/oxagen/contracts/spend.operator_ranking";
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { readOperatorFacts, type ReadOperatorFacts } from "./lib/operator-facts";
import {
  operatorPseudonym,
  type PseudonymPolicy,
  readPseudonymPolicy,
} from "./lib/operator-pseudonyms";

export type RankingScope = { orgId: string; workspaceId: string };
type Window = { start: Date; end: Date };

/** One operator's priced spend in one currency over the window. */
export type OperatorSpend = {
  operatorKey: string;
  currency: string;
  micros: bigint;
};

export type OperatorRankingDeps = {
  readClaims: (
    scope: RankingScope,
    window: Window,
  ) => Promise<UnproductiveClaim[]>;
  /** Priced spend of the named operators' runs that started in the window. */
  readOperatorSpend: (
    scope: RankingScope,
    window: Window,
    operatorKeys: readonly string[],
  ) => Promise<OperatorSpend[]>;
  readOperatorFacts: ReadOperatorFacts;
  readPolicy: (scope: RankingScope) => Promise<PseudonymPolicy>;
  /** The person's `workspace_users.role`, lowercased, or null when absent. */
  readWorkspaceRole: (
    scope: RankingScope,
    userId: string,
  ) => Promise<string | null>;
};

/** Who may read the ranking: the roles the contract's defaultRoles allow. */
export const RANKING_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner"],
} as const;

async function readWorkspaceRole(
  scope: RankingScope,
  userId: string,
): Promise<string | null> {
  // withSystemDb, as capability-role-guard reads it: this read decides
  // whether the caller may act in the scope, so it must not depend on it.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ role: schema.workspaceUsers.role })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, scope.workspaceId),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .limit(1),
  );
  // The column holds both casings (capability-role-guard's permittedRoles).
  return rows[0]?.role?.toLowerCase() ?? null;
}

async function readClaims(
  scope: RankingScope,
  window: Window,
): Promise<UnproductiveClaim[]> {
  return withTenantDb((tx) => readUnproductiveClaims(tx, scope, window));
}

async function readOperatorSpend(
  scope: RankingScope,
  window: Window,
  operatorKeys: readonly string[],
): Promise<OperatorSpend[]> {
  if (operatorKeys.length === 0) return [];
  const totals = schema.runTotals;
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        operatorKey: totals.operatorKey,
        currency: totals.currency,
        micros: sql<string>`sum(${totals.costMicros})::text`,
      })
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(totals.startedAt, window.start),
          lt(totals.startedAt, window.end),
          isNotNull(totals.costMicros),
          inArray(totals.operatorKey, [...operatorKeys]),
        ),
      )
      .groupBy(totals.operatorKey, totals.currency),
  );
  return rows.flatMap((r) =>
    r.operatorKey === null
      ? []
      : [
          {
            operatorKey: r.operatorKey,
            currency: r.currency,
            micros: BigInt(r.micros),
          },
        ],
  );
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
    try {
      await assertOrgRole(
        { ...ctx, userId },
        {
          org: [...RANKING_ROLES.org],
          workspace: [...RANKING_ROLES.workspace],
        },
      );
    } catch (err) {
      if (!isHandlerError(err) || err.code !== "forbidden" || !userId) {
        throw err;
      }
      // No person holds a workspace IAM role yet (#3198), so the workspace
      // Owner comes from the membership row.
      if ((await deps.readWorkspaceRole(scope, userId)) !== "owner") throw err;
    }
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
    const [spend, facts] = await Promise.all([
      pseudonyms || keys.length === 0
        ? Promise.resolve<OperatorSpend[]>([])
        : deps.readOperatorSpend(scope, window, keys),
      pseudonyms || keys.length === 0
        ? Promise.resolve(new Map<string, OperatorFacts>())
        : deps.readOperatorFacts(scope, keys),
    ]);
    // An operator whose priced spend holds another currency has no share: the
    // part is in one currency and the whole would be in two.
    const spendOf = new Map<string, bigint | null>();
    for (const s of spend) {
      const held = spendOf.get(s.operatorKey);
      if (s.currency !== currency || held === null) {
        spendOf.set(s.operatorKey, null);
      } else {
        spendOf.set(s.operatorKey, (held ?? 0n) + s.micros);
      }
    }

    const shareOf = (micros: bigint, key: string): number | null => {
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
        unproductiveShare: pseudonyms ? null : shareOf(o.micros, o.key),
        runs: pseudonyms ? null : own.size,
        topRuns,
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
  readWorkspaceRole,
});
