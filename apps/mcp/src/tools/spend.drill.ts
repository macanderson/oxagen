import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...spendDrill.input.shape,
  kind: spendDrill.input.shape.kind.describe(
    "What the key names: an operator, an agent or a tool",
  ),
  key: spendDrill.input.shape.key.describe(
    "The operator's principal id, the agent key (org_ns.ws_ns.slug) or the tool name",
  ),
  days: spendDrill.input.shape.days.describe(
    "Trailing window ending today, in days (1–92; default 30)",
  ),
};

export const metadata: ToolMetadata = {
  name: spendDrill.name,
  description: spendDrill.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function spendDrillTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(spendDrill.name, args, ctx, { surface: "mcp" });
  return spendDrill.output.parse(output);
}
