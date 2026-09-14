// Pure mappers for the live spend adapter (plan §5 Batch 3, lane A7). They take
// rows in a contract's own output type and return view-model candidates; the
// adapter parses every candidate through the view-model schema before a page
// sees it.
//
// Column-level mapping, checked against packages/database/src/schema,
// packages/telemetry/src/schema.sql and the two read contracts:
//
// ClickHouse `token_usage`, read through `get_usage_breakdown`
// (billing.usage.breakdown → readUsageBreakdown) → SpendByModel
//
//   model          token_usage.model (the group key)                recorded
//   calls          count() per model (`executions`: one row = one    recorded
//                  model call)
//   spend          sum(cost_usd_micros) as USD micros                recorded
//                  basis `estimated`: @oxagen/ai prices provider-reported
//                  tokens with its in-code rate card (providerCostUsdMicros);
//                  no price-book entry id is recorded (G3), so the weaker
//                  basis is the honest one
//   cacheHitRate   sum(cached_tokens) / (sum(input_tokens) −          derived
//                  sum(cache_write_tokens)), spec §12.6. input_tokens is the
//                  inclusive total (fresh + cache reads + cache writes), so the
//                  denominator is input_uncached + cache_read. Undefined when a
//                  model has no prompt tokens (0/0): the row does not fit a
//                  non-null Ratio and the read is not backed (promote: nullable)
//   assistant      true for every row. @oxagen/ai is the only writer of  structural
//                  token_usage, so every row is a model call Oxagen made (the
//                  in-app agent and the platform jobs behind it). A customer
//                  agent's own model calls reach no Oxagen table until the model
//                  proxy records them (§7.1), so no row is a customer agent's
//
// Not mappable from the same breakdown, so their methods stay not backed:
//
//   byOperator     `agents`, `runs`, `budget`, `budgetUsedRatio` are not
//                  recorded per person: token_usage has no run id
//                  (execution_step_id is a turn), and spend_budgets has no
//                  operator scope. Operator rollups are cost.daily_totals (G3).
//   byAgent        `runs` and `trendPercent` are not recorded; and token_usage
//                  rows under an agent principal are Oxagen capability calls the
//                  agent made, not the agent's own model spend (G3).
//   byTool         ClickHouse `tool_invocations` records calls, turns
//                  (execution_step_id), latency and status per capability, but
//                  no cost column, and no read contract exists for the table.
//                  Spend per tool is tool calls × declared price (G3).
//   drill          cross-cut slices (an agent's spend by model, …) need a
//                  grouping no contract returns (G3).
//
// Postgres `billing.spend_budgets`, read through `get_spend_budget`
// (billing.budget.get → getSpendBudgetStatuses) → Budget
//
//   scopeKind      workspace_id NULL → `org`; non-NULL → `workspace`  recorded
//   scopeId        org.organizations.slug / workspace.workspaces.slug recorded
//   period         period (CHECK monthly | rolling)                   recorded
//                  window_days is dropped: Budget has no field for it (promote)
//   limit          limit_micros (bigint), via the contract's limitUsd recorded
//   spent          sumSpendMicros over token_usage for the window     derived
//                  basis `estimated` (the same token_usage cost as above)
//   mode           `hard`: the ceiling is enforced in invoke()        recorded
//                  admission and denies before the provider call
//   enabled=false  excluded: a disabled ceiling is a documented no-op, and
//                  Budget has no `enabled` field to say so (promote)
//
// `workspace.workspace_budget_policy` (get_budget_policy) is NOT a Budget: it
// caps one agent turn, has no period-to-date spend, and Budget's `per_run` is
// the agent definition's run cap, not a turn cap. Listed under promote.
import type { BillingBudgetGetOutput } from "@oxagen/oxagen/contracts/billing.budget.get";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import type { Budget, Money, SpendByModel } from "@/data/contracts";

export type UsageModelRow = BillingUsageBreakdownOutput["byModel"][number];
export type SpendBudgetStatus = BillingBudgetGetOutput["budgets"][number];

/** The only currency any store records today (spec §15: the wedge is USD only). */
export const SPEND_CURRENCY = "USD";

/**
 * The largest micro-USD amount a contract's float dollars carry back to exact
 * integer micros: 2^50 micros, about $1.1 billion. Above it a float round trip
 * can move the value, so the mapper refuses rather than show a nearby number.
 */
export const MAX_EXACT_MICROS = 2 ** 50;

/** A value a contract returned that the view model cannot carry without changing it. */
export class SpendContractMismatch extends Error {
  readonly code = "spend_contract_mismatch";
  constructor(
    readonly field: string,
    readonly value: unknown,
  ) {
    super(
      `spend value at ${field} cannot be carried exactly: ${String(value)}`,
    );
    this.name = "SpendContractMismatch";
  }
}

/** The calendar month (UTC) containing `now`, as a half-open window. */
export function monthWindow(now: Date): {
  period: string;
  start: string;
  end: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return {
    period: start.toISOString().slice(0, 7),
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function exactMicros(field: string, micros: number): string {
  if (!Number.isSafeInteger(micros) || Math.abs(micros) > MAX_EXACT_MICROS)
    throw new SpendContractMismatch(field, micros);
  return String(micros);
}

/** Integer micro-USD (as token_usage sums it) to Money. */
export function moneyFromMicros(
  field: string,
  micros: number,
  basis?: Money["basis"],
): Money {
  const money: Money = {
    micros: exactMicros(field, micros),
    currency: SPEND_CURRENCY,
  };
  if (basis !== undefined) money.basis = basis;
  return money;
}

/**
 * Float USD (as get_spend_budget returns it, converted from bigint micros by
 * `Number(micros) / 1e6`) back to Money. Exact below MAX_EXACT_MICROS.
 */
export function moneyFromUsd(
  field: string,
  usd: number,
  basis?: Money["basis"],
): Money {
  if (!Number.isFinite(usd)) throw new SpendContractMismatch(field, usd);
  return moneyFromMicros(field, Math.round(usd * 1_000_000), basis);
}

/**
 * Cache hit rate per spec §12.6: cache_read / (input_uncached + cache_read).
 * Null when it is undefined (no prompt tokens) or the sums contradict each
 * other; never a zero standing in for "cannot be computed".
 */
export function cacheHitRate(row: {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}): number | null {
  const denominator = row.inputTokens - row.cacheWriteTokens;
  if (denominator <= 0) return null;
  const rate = row.cachedTokens / denominator;
  return rate >= 0 && rate <= 1 ? rate : null;
}

/** The view-model paths a real row can leave unrecorded. */
export const UNRECORDED_MODEL_PATHS = ["cacheHitRate"] as const;

export type ModelCandidate =
  | { ok: true; value: SpendByModel }
  | {
      ok: false;
      model: string;
      unrecorded: (typeof UNRECORDED_MODEL_PATHS)[number];
    };

export function toSpendByModel(row: UsageModelRow): ModelCandidate {
  const rate = cacheHitRate(row);
  if (rate === null)
    return { ok: false, model: row.key, unrecorded: "cacheHitRate" };
  return {
    ok: true,
    value: {
      model: row.key,
      assistant: true,
      calls: row.executions,
      spend: moneyFromMicros(
        `byModel.${row.key}.costMicros`,
        row.costMicros,
        "estimated",
      ),
      cacheHitRate: rate,
    },
  };
}

/** The slugs a budget's scope is shown by. */
export type ScopeSlugs = { org: string; workspace: string | null };

/**
 * One configured ceiling to a Budget, or null when it has nothing to show: a
 * disabled ceiling (a documented no-op) or a status with no limit configured.
 * Throws when a workspace ceiling arrives without the workspace's slug.
 */
export function toBudget(
  status: SpendBudgetStatus,
  slugs: ScopeSlugs,
): Budget | null {
  if (!status.enabled || status.limitUsd === null) return null;
  const scopeId = status.scope === "org" ? slugs.org : slugs.workspace;
  if (scopeId === null)
    throw new SpendContractMismatch("budgets.scopeId", status.publicId);
  const field = `budgets.${status.publicId ?? status.scope}`;
  return {
    scopeKind: status.scope,
    scopeId,
    period: status.period,
    limit: moneyFromUsd(`${field}.limitUsd`, status.limitUsd),
    spent: moneyFromUsd(`${field}.spentUsd`, status.spentUsd, "estimated"),
    mode: "hard",
  };
}
