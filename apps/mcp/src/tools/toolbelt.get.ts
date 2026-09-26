import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolbeltGet } from "@oxagen/oxagen/contracts/toolbelt.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  toolbeltId: toolbeltGet.input.shape.toolbeltId.describe(
    "The toolbelt's public id (tbt_…), from list_toolbelts",
  ),
};

export const metadata: ToolMetadata = {
  name: toolbeltGet.name,
  description: toolbeltGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolbeltGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolbeltGet.name, args, ctx, {
    surface: "mcp",
  });
  return toolbeltGet.output.parse(output);
}
