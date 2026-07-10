import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerCustomerCreate } from "@oxagen/oxagen/contracts/billing.reseller_customer.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerCustomerCreate.input.shape };

export const metadata: ToolMetadata = {
  name: resellerCustomerCreate.name,
  description: resellerCustomerCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function resellerCustomerCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerCustomerCreate.name, args, ctx, {
    surface: "mcp",
  });
  return resellerCustomerCreate.output.parse(output);
}
