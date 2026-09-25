// audit-exempt: read-only — returns the active scope's spend-budget configuration and live burn (getSpendBudgetStatuses reads fresh, bypassing the gate cache); mutates nothing. The kernel capability.invoke_* audit covers access.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { getSpendBudgetStatuses } from "@oxagen/billing";
import { toSpendBudgetDto } from "./lib/spend-budget-dto";

/**
 * get_spend_budget — the active scope's configured spend ceilings with their
 * live burn. Runs inside the kernel-established tenant scope; listSpendBudgets'
 * RLS (`workspace_nullable`) returns the org-default row AND this workspace's
 * own row, so the panel sees both scopes in one read. Spend is read FRESH
 * (getSpendBudgetStatuses bypasses the gate's short-TTL cache) so the panel is
 * accurate. A failed spend read fails the call: a zero in its place would
 * report a ceiling past its limit as `ok` (#3064).
 */
export const billingBudgetGetHandler: CapabilityHandler<
  typeof billingBudgetGet
> = async (_input, ctx) => {
  const statuses = await getSpendBudgetStatuses({ orgId: ctx.orgId });
  return { budgets: statuses.map(toSpendBudgetDto) };
};
