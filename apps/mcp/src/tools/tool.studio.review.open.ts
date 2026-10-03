import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioReviewOpen } from "@oxagen/oxagen/contracts/tool.studio.review.open";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  server: toolStudioReviewOpen.input.shape.server.describe(
    "The server folder under tools/servers/ whose draft becomes the steering PR",
  ),
  revision: toolStudioReviewOpen.input.shape.revision.describe(
    "The draft revision to review. A newer draft is refused",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioReviewOpen.name,
  description: toolStudioReviewOpen.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function toolStudioReviewOpenTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioReviewOpen.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(toolStudioReviewOpen.output.parse(output));
}
