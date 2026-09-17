import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingAutoTopupSet } from "@oxagen/oxagen/contracts/billing.auto_topup.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...billingAutoTopupSet.input.shape,
  enabled: billingAutoTopupSet.input.shape.enabled.describe(
    "Charge the saved card automatically when the governed-action-unit bucket runs out",
  ),
  blocks: billingAutoTopupSet.input.shape.blocks.describe(
    "Blocks of governed action units to buy per top-up (1-100)",
  ),
};

export const metadata: ToolMetadata = {
  name: billingAutoTopupSet.name,
  description: billingAutoTopupSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingAutoTopupSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingAutoTopupSet.name, args, ctx, {
    surface: "mcp",
  });
  return billingAutoTopupSet.output.parse(output);
}
