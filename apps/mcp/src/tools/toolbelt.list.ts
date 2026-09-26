import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolbeltList } from "@oxagen/oxagen/contracts/toolbelt.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...toolbeltList.input.shape };

export const metadata: ToolMetadata = {
  name: toolbeltList.name,
  description: toolbeltList.description,
  annotations: {
    // The first read in a workspace creates its All tools belt; every read
    // after answers the same.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolbeltListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolbeltList.name, args, ctx, {
    surface: "mcp",
  });
  return toolbeltList.output.parse(output);
}
