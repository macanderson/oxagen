import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runtimeCreate } from "@oxagen/oxagen/contracts/runtime.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  name: runtimeCreate.input.shape.name.describe(
    'What the runtime is called, for example "Mac\'s laptop" or "Build VM"',
  ),
  slug: runtimeCreate.input.shape.slug.describe(
    "Lowercase letters and digits joined by hyphens; derived from the name when omitted",
  ),
  containmentRequired: runtimeCreate.input.shape.containmentRequired.describe(
    "Whether every agent on the runtime must run under the contained launcher; false when omitted",
  ),
};

export const metadata: ToolMetadata = {
  name: runtimeCreate.name,
  description: runtimeCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function runtimeCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runtimeCreate.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(runtimeCreate.output.parse(output));
}
