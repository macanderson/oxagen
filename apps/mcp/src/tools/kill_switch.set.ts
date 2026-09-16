import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { killSwitchSet } from "@oxagen/oxagen/contracts/kill_switch.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...killSwitchSet.input.shape,
  target: killSwitchSet.input.shape.target.describe(
    "What to stop: { kind: tool_version | tool_server | connection | agent | operator | workspace | org | class, id } — the public id, or the consequence tag for a class",
  ),
  on: killSwitchSet.input.shape.on.describe(
    "true to flip the switch on (deny), false to clear it",
  ),
  reason: killSwitchSet.input.shape.reason.describe(
    "Why; recorded on the deny row and the security event",
  ),
};

export const metadata: ToolMetadata = {
  name: killSwitchSet.name,
  description: killSwitchSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function killSwitchSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(killSwitchSet.name, args, ctx, {
    surface: "mcp",
  });
  return killSwitchSet.output.parse(output);
}
