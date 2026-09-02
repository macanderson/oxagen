import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpDelete } from "@oxagen/oxagen/contracts/agent.mcp.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMcpDelete.input.shape,
  mcpServerId: agentMcpDelete.input.shape.mcpServerId.describe(
    "ID of the registered external MCP server to soft-delete",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMcpDelete.name,
  description: agentMcpDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function agentMcpDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMcpDelete.name, args, ctx, {
    surface: "mcp",
  });
  return agentMcpDelete.output.parse(output);
}
