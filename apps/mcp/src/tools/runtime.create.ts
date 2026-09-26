import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runtimeCreate } from "@oxagen/oxagen/contracts/runtime.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  name: runtimeCreate.input.shape.name.describe(
    'What the runtime is called, for example "Mac\'s laptop" or "Build VM"',
  ),
  slug: runtimeCreate.input.shape.slug.describe(
    "Lowercase letters and digits joined by hyphens; derived from the name when omitted",
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
  return runtimeCreate.output.parse(output);
}
