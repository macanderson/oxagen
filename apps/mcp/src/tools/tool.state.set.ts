import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStateSet } from "@oxagen/oxagen/contracts/tool.state.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// The contract refines its object twice (one target, at least one switch),
// so the tool lists the object's own fields and the kernel applies both
// refinements when it parses the call.
const fields = toolStateSet.input.innerType().innerType().shape;

export const schema = {
  toolIds: fields.toolIds.describe(
    "The tools to change (tol_…); name these or serverId, not both",
  ),
  serverId: fields.serverId.describe(
    "Every tool one MCP server contributed (mcs_…), or null for the declared tools",
  ),
  available: fields.available.describe(
    "True makes the tools available to toolbelts; false takes them out of every belt",
  ),
  defaultActive: fields.defaultActive.describe(
    "Whether the tools start active in the All tools belt and in new clones",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStateSet.name,
  description: toolStateSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolStateSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStateSet.name, args, ctx, {
    surface: "mcp",
  });
  return toolStateSet.output.parse(output);
}
