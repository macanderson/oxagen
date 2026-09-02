import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { budgetPolicyRead } from "@oxagen/oxagen/contracts/budget.policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: budgetPolicyRead.name,
  description: budgetPolicyRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function budgetPolicyReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(budgetPolicyRead.name, {}, ctx, {
    surface: "mcp",
  });
  return budgetPolicyRead.output.parse(output);
}
