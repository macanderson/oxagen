import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  spendDrill,
  spendDrillInputObject,
} from "@oxagen/oxagen/contracts/spend.drill";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Built from the contract's base object (the refined `input` has no `.shape`);
// invoke() parses the refined input, so the operator-key rule holds here too.
export const schema = {
  ...spendDrillInputObject.shape,
  kind: spendDrillInputObject.shape.kind.describe(
    "What the key names: an operator, an agent or a tool",
  ),
  key: spendDrillInputObject.shape.key.describe(
    "The operator's principal public id (prn_…), the agent key (org_ns.ws_ns.slug) or the tool name",
  ),
  days: spendDrillInputObject.shape.days.describe(
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
