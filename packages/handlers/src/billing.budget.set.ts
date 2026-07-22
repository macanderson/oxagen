import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import {
  getSpendBudgetStatuses,
  invalidateSpendBudgetScope,
  setSpendBudget,
  type SpendBudgetStatus,
} from "@oxagen/billing";

/** USD → micro-USD (1 USD = 1_000_000), integer math on a dollar ceiling. */
function usdToMicros(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

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
 * set_spend_budget — create or replace one scope's hard spend ceiling. Raising a
 * ceiling is the org-admin override that clears a `budget_exceeded` denial; the
 * kernel audit chain records it (IAM-gated on the api/mcp surface; the app panel
 * adds an explicit billing-manager gate since apps/app skips kernel IAM).
 *
 * After the write we drop the org's cached config + spend (best-effort,
 * per-process) so a raised ceiling takes effect immediately rather than after
 * the gate's short TTL, then re-read the saved scope's live status to return.
 */
export const billingBudgetSetHandler: CapabilityHandler<
  typeof billingBudgetSet
> = async (input, ctx) => {
  const workspaceId = input.scope === "workspace" ? ctx.workspaceId : null;

  await setSpendBudget({
    orgId: ctx.orgId,
    workspaceId,
    enabled: input.enabled,
    period: input.period,
    windowDays: input.period === "rolling" ? (input.windowDays ?? null) : null,
    limitMicros: usdToMicros(input.limitUsd),
    actorUserId: ctx.userId,
  });

  // Clear the (short-TTL) gate cache so the new ceiling is live at once.
  invalidateSpendBudgetScope({ orgId: ctx.orgId });

  // Re-read the saved scope's live status (fresh spend) for the panel.
  const statuses = await getSpendBudgetStatuses();
  const saved = statuses.find((s) => s.budget.scope === input.scope);
  if (!saved) {
    throw new Error(
      `set_spend_budget: saved ${input.scope} ceiling not found on read-back`,
    );
  }
  return toDto(saved);
};
