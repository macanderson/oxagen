import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { budgetPolicyWrite } from "@oxagen/oxagen/contracts/budget.policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...budgetPolicyWrite.input.shape,
  enabled: budgetPolicyWrite.input.shape.enabled.describe(
    "Turn the per-turn dollar budget on or off (omit to leave unchanged)",
  ),
  limitUsd: budgetPolicyWrite.input.shape.limitUsd.describe(
    "Per-turn ceiling in USD, e.g. 2.50 (null clears the limit; omit to leave unchanged)",
  ),
  mode: budgetPolicyWrite.input.shape.mode.describe(
    "Enforcement at the ceiling: grace = allow overage within a grace window then stop; prompt = pause and ask to continue; enforce = hard stop the instant the limit is crossed",
  ),
  graceOveragePct: budgetPolicyWrite.input.shape.graceOveragePct.describe(
    "grace mode only: fraction ABOVE the limit allowed before a hard stop (0.25 = allow 25% overage)",
  ),
};

export const metadata: ToolMetadata = {
  name: budgetPolicyWrite.name,
  description: budgetPolicyWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function budgetPolicyWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(budgetPolicyWrite.name, args, ctx, {
    surface: "mcp",
  });
  return budgetPolicyWrite.output.parse(output);
}
