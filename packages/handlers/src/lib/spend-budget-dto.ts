// spend-budget-dto.ts — one mapping from @oxagen/billing's SpendBudgetStatus to
// the shape `get_spend_budget` and `set_spend_budget` return, so the two
// handlers cannot drift. Money leaves as micro-USD in a decimal string with
// its currency (ADR-057 decision 2, INV-09): the store keeps `limit_micros`
// bigint and nothing here divides by a million.
import type { SpendBudgetStatus } from "@oxagen/billing";
import { microsString, type Money } from "@oxagen/oxagen/money";
import type { SpendBudgetStatusDto } from "@oxagen/oxagen/contracts/billing.budget.get";

/** `billing.spend_budgets.limit_micros` and `token_usage.cost_usd_micros` are micro-USD. */
export const SPEND_BUDGET_CURRENCY = "USD";

export function microsToMoney(micros: bigint): Money {
  return { micros: microsString(micros), currency: SPEND_BUDGET_CURRENCY };
}

export function toSpendBudgetDto(
  status: SpendBudgetStatus,
): SpendBudgetStatusDto {
  return {
    scope: status.budget.scope,
    publicId: status.budget.publicId,
    enabled: status.budget.enabled,
    period: status.budget.period,
    windowDays: status.budget.windowDays,
    limit: microsToMoney(status.budget.limitMicros),
    spent: microsToMoney(status.spentMicros),
    projected: microsToMoney(status.projectedMicros),
    ratio: status.ratio,
    state: status.state,
    reachedThreshold: status.reachedThreshold,
    windowStart: status.window.start,
    windowEnd: status.window.end,
  };
}
