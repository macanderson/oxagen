import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentToolList } from "@oxagen/oxagen/contracts/agent.tool.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentToolList.input.shape,
  includeExternal: agentToolList.input.shape.includeExternal.describe(
    "Include externally-registered tools",
  ),
};

export const metadata: ToolMetadata = {
  name: agentToolList.name,
  description: agentToolList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentToolListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentToolList.name, args, ctx, {
    surface: "mcp",
  });
  return agentToolList.output.parse(output);
}
