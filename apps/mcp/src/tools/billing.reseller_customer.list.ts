import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerCustomerList } from "@oxagen/oxagen/contracts/billing.reseller_customer.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerCustomerList.input.shape };

export const metadata: ToolMetadata = {
  name: resellerCustomerList.name,
  description: resellerCustomerList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerCustomerListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerCustomerList.name, args, ctx, {
    surface: "mcp",
  });
  return resellerCustomerList.output.parse(output);
}
