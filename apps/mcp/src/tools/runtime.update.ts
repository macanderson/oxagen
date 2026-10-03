import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runtimeUpdate } from "@oxagen/oxagen/contracts/runtime.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  runtimeId: runtimeUpdate.input.shape.runtimeId.describe(
    "The runtime to change, by its rtm_ id",
  ),
  name: runtimeUpdate.input.shape.name.describe(
    "The new name; the slug stays. Omit to keep the name",
  ),
  containmentRequired: runtimeUpdate.input.shape.containmentRequired.describe(
    "Whether every agent on the runtime must run under the contained launcher. Omit to keep the setting",
  ),
};

export const metadata: ToolMetadata = {
  name: runtimeUpdate.name,
  description: runtimeUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runtimeUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runtimeUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(runtimeUpdate.output.parse(output));
}
