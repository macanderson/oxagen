import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerRebillPush } from "@oxagen/oxagen/contracts/billing.reseller_rebill.push";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerRebillPush.input.shape };

export const metadata: ToolMetadata = {
  name: resellerRebillPush.name,
  description: resellerRebillPush.description,
  // Idempotent per (customer, period): a re-push updates the run and never
  // creates a second invoice.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerRebillPushTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerRebillPush.name, args, ctx, {
    surface: "mcp",
  });
  return resellerRebillPush.output.parse(output);
}
