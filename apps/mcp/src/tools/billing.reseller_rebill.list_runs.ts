import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerRebillListRuns } from "@oxagen/oxagen/contracts/billing.reseller_rebill.list_runs";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerRebillListRuns.input.shape };

export const metadata: ToolMetadata = {
  name: resellerRebillListRuns.name,
  description: resellerRebillListRuns.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerRebillListRunsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerRebillListRuns.name, args, ctx, {
    surface: "mcp",
  });
  return resellerRebillListRuns.output.parse(output);
}
