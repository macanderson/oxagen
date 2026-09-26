import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolbeltDelete } from "@oxagen/oxagen/contracts/toolbelt.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  toolbeltId: toolbeltDelete.input.shape.toolbeltId.describe(
    "The custom belt to delete (tbt_…); no live agent may carry it",
  ),
};

export const metadata: ToolMetadata = {
  name: toolbeltDelete.name,
  description: toolbeltDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function toolbeltDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolbeltDelete.name, args, ctx, {
    surface: "mcp",
  });
  return toolbeltDelete.output.parse(output);
}
