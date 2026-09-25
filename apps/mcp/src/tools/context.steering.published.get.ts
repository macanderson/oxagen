import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { publishedSteeringGet } from "@oxagen/oxagen/contracts/context.steering.published.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  bindingId: publishedSteeringGet.input.shape.bindingId.describe(
    "A repository's binding id (rpb_…) from list_repositories; omit it to read the workspace's main repository",
  ),
};

export const metadata: ToolMetadata = {
  name: publishedSteeringGet.name,
  description: publishedSteeringGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function publishedSteeringGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(publishedSteeringGet.name, args, ctx, {
    surface: "mcp",
  });
  return publishedSteeringGet.output.parse(output);
}
