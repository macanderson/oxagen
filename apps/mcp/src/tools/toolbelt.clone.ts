import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolbeltClone } from "@oxagen/oxagen/contracts/toolbelt.clone";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  toolbeltId: toolbeltClone.input.shape.toolbeltId.describe(
    "The belt to copy (tbt_…); the All tools belt is the usual start",
  ),
  name: toolbeltClone.input.shape.name.describe("The new belt's name"),
  slug: toolbeltClone.input.shape.slug.describe(
    "Lowercase letters and digits joined by hyphens; derived from the name when omitted",
  ),
  description: toolbeltClone.input.shape.description.describe(
    "What the belt is for",
  ),
};

export const metadata: ToolMetadata = {
  name: toolbeltClone.name,
  description: toolbeltClone.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function toolbeltCloneTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolbeltClone.name, args, ctx, {
    surface: "mcp",
  });
  return toolbeltClone.output.parse(output);
}
