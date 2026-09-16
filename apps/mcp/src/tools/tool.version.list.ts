import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...toolVersionList.input.shape,
  category: toolVersionList.input.shape.category.describe(
    "Only versions carrying this consequence tag (snake_case, e.g. moves_money)",
  ),
  limit: toolVersionList.input.shape.limit.describe(
    "Max versions to return (1–100)",
  ),
  cursor: toolVersionList.input.shape.cursor.describe(
    "The nextCursor of an earlier page; omit for the first page",
  ),
};

export const metadata: ToolMetadata = {
  name: toolVersionList.name,
  description: toolVersionList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolVersionListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolVersionList.name, args, ctx, {
    surface: "mcp",
  });
  return toolVersionList.output.parse(output);
}
