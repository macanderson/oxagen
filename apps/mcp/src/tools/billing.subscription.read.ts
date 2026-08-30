import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: billingSubscriptionRead.name,
  description: billingSubscriptionRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingSubscriptionReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingSubscriptionRead.name, {}, ctx, {
    surface: "mcp",
  });
  return billingSubscriptionRead.output.parse(output);
}
