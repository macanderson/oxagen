import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceBudgetPolicyWrite } from "@oxagen/oxagen/contracts/workspace.budget_policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workspaceBudgetPolicyWrite.input.shape,
  enabled: workspaceBudgetPolicyWrite.input.shape.enabled.describe(
    "Turn the workspace budget governance on or off (omit to leave unchanged)",
  ),
  limitUsd: workspaceBudgetPolicyWrite.input.shape.limitUsd.describe(
    "Workspace per-turn ceiling in USD, e.g. 100.00 (null clears the limit; omit to leave unchanged)",
  ),
  mode: workspaceBudgetPolicyWrite.input.shape.mode.describe(
    "Enforcement at the ceiling: grace = allow overage within a grace window then stop; prompt = pause and ask to continue; enforce = hard stop the instant the limit is crossed",
  ),
  graceOveragePct:
    workspaceBudgetPolicyWrite.input.shape.graceOveragePct.describe(
      "grace mode only: fraction ABOVE the limit allowed before a hard stop (0.25 = allow 25% overage)",
    ),
  enforcement: workspaceBudgetPolicyWrite.input.shape.enforcement.describe(
    "Hard enforcement policy: ceiling = members cannot exceed the limit, the workspace mode can only get stricter; default = seeds members who haven't set their own budget, they can override",
  ),
};

export const metadata: ToolMetadata = {
  name: workspaceBudgetPolicyWrite.name,
  description: workspaceBudgetPolicyWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceBudgetPolicyWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceBudgetPolicyWrite.name, args, ctx, {
    surface: "mcp",
  });
  return workspaceBudgetPolicyWrite.output.parse(output);
}
