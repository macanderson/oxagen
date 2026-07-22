import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: billingBudgetGet.name,
  description: billingBudgetGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingBudgetGetTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingBudgetGet.name, {}, ctx, {
    surface: "mcp",
  });
  return billingBudgetGet.output.parse(output);
}
