import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolDeclarationList } from "@oxagen/oxagen/contracts/tool.declaration.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...toolDeclarationList.input.shape,
  source: toolDeclarationList.input.shape.source.describe(
    "Only return declarations from this source (builtin | custom | mcp | foundry)",
  ),
  limit: toolDeclarationList.input.shape.limit.describe(
    "Maximum number of tools to return (default 50, max 200)",
  ),
  offset: toolDeclarationList.input.shape.offset.describe(
    "Pagination offset — number of tools to skip",
  ),
};

export const metadata: ToolMetadata = {
  name: toolDeclarationList.name,
  description: toolDeclarationList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolDeclarationListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolDeclarationList.name, args, ctx, {
    surface: "mcp",
  });
  return toolDeclarationList.output.parse(output);
}
