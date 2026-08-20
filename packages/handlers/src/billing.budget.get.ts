// audit-exempt: read-only — returns the active scope's spend-budget configuration and live burn (getSpendBudgetStatuses reads fresh, bypassing the gate cache); mutates nothing. The kernel capability.invoke_* audit covers access.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import {
  getSpendBudgetStatuses,
  type SpendBudgetStatus,
} from "@oxagen/billing";

/** micro-USD (1 USD = 1_000_000) → plain USD for the client. */
function microsToUsd(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

function toDto(status: SpendBudgetStatus): {
  scope: "org" | "workspace";
  publicId: string | null;
  enabled: boolean;
  period: "monthly" | "rolling";
  windowDays: number | null;
  limitUsd: number | null;
  spentUsd: number;
  projectedUsd: number;
  ratio: number;
  state: SpendBudgetStatus["state"];
  reachedThreshold: number;
  windowStart: string;
  windowEnd: string;
} {
  return {
    scope: status.budget.scope,
    publicId: status.budget.publicId,
    enabled: status.budget.enabled,
    period: status.budget.period,
    windowDays: status.budget.windowDays,
    limitUsd: microsToUsd(status.budget.limitMicros),
    spentUsd: microsToUsd(status.spentMicros),
    projectedUsd: microsToUsd(status.projectedMicros),
    ratio: status.ratio,
    state: status.state,
    reachedThreshold: status.reachedThreshold,
    windowStart: status.window.start,
    windowEnd: status.window.end,
  };
}

/**
 * get_spend_budget — the active scope's configured spend ceilings with their
 * live burn. Runs inside the kernel-established tenant scope; getScopeBudgets'
 * RLS (`workspace_nullable`) returns the org-default row AND this workspace's
 * own row, so the panel sees both scopes in one read. Spend is read FRESH
 * (getSpendBudgetStatuses bypasses the gate's short-TTL cache) so the panel is
 * accurate, and never throws on a degraded ClickHouse (reports spent = 0).
 */
export const billingBudgetGetHandler: CapabilityHandler<
  typeof billingBudgetGet
> = async () => {
  const statuses = await getSpendBudgetStatuses();
  return { budgets: statuses.map(toDto) };
};
