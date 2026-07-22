import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  billingBudgetSet,
  spendBudgetSetInputObject,
} from "@oxagen/oxagen/contracts/billing.budget.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Derived from the contract's base object (the refined `input` has no `.shape`).
// invoke() re-parses the full refined contract input, so the rolling/monthly
// window rule is still enforced when the tool is called.
export const schema = {
  ...spendBudgetSetInputObject.shape,
  scope: spendBudgetSetInputObject.shape.scope.describe(
    "Which ceiling to set: 'org' (covers every workspace) or 'workspace' (the active workspace)",
  ),
  enabled: spendBudgetSetInputObject.shape.enabled.describe(
    "Whether the ceiling is enforced (false keeps the config but stops gating)",
  ),
  period: spendBudgetSetInputObject.shape.period.describe(
    "Window the ceiling is measured over: 'monthly' = calendar month to date; 'rolling' = a trailing N-day window",
  ),
  windowDays: spendBudgetSetInputObject.shape.windowDays.describe(
    "For 'rolling' only: trailing window length in days (> 0). Omit for 'monthly'",
  ),
  limitUsd: spendBudgetSetInputObject.shape.limitUsd.describe(
    "The hard ceiling in USD, e.g. 500 for $500 (> 0)",
  ),
};

export const metadata: ToolMetadata = {
  name: billingBudgetSet.name,
  description: billingBudgetSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingBudgetSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingBudgetSet.name, args, ctx, {
    surface: "mcp",
  });
  return billingBudgetSet.output.parse(output);
}
