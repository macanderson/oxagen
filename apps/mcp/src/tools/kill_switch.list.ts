import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...killSwitchList.input.shape,
  onlyOn: killSwitchList.input.shape.onlyOn.describe(
    "Only switches currently on",
  ),
  limit: killSwitchList.input.shape.limit.describe(
    "Max switches to return (1–200)",
  ),
};

export const metadata: ToolMetadata = {
  name: killSwitchList.name,
  description: killSwitchList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function killSwitchListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(killSwitchList.name, args, ctx, {
    surface: "mcp",
  });
  return killSwitchList.output.parse(output);
}
