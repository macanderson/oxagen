import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerCustomerArchive } from "@oxagen/oxagen/contracts/billing.reseller_customer.archive";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerCustomerArchive.input.shape };

export const metadata: ToolMetadata = {
  name: resellerCustomerArchive.name,
  description: resellerCustomerArchive.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function resellerCustomerArchiveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerCustomerArchive.name, args, ctx, {
    surface: "mcp",
  });
  return resellerCustomerArchive.output.parse(output);
}
