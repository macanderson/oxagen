import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceBudgetPolicyRead } from "@oxagen/oxagen/contracts/workspace.budget_policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: workspaceBudgetPolicyRead.name,
  description: workspaceBudgetPolicyRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceBudgetPolicyReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceBudgetPolicyRead.name, {}, ctx, {
    surface: "mcp",
  });
  return workspaceBudgetPolicyRead.output.parse(output);
}
