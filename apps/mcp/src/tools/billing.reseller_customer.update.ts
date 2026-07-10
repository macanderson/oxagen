import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerCustomerUpdate } from "@oxagen/oxagen/contracts/billing.reseller_customer.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerCustomerUpdate.input.shape };

export const metadata: ToolMetadata = {
  name: resellerCustomerUpdate.name,
  description: resellerCustomerUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerCustomerUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerCustomerUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return resellerCustomerUpdate.output.parse(output);
}
