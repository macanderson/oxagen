import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpSetEnabled } from "@oxagen/oxagen/contracts/agent.mcp.set_enabled";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMcpSetEnabled.input.shape,
  mcpServerId: agentMcpSetEnabled.input.shape.mcpServerId.describe(
    "ID of the registered external MCP server to enable or disable",
  ),
  enabled: agentMcpSetEnabled.input.shape.enabled.describe(
    "True to enable the server (re-capture tool snapshots), false to disable it",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMcpSetEnabled.name,
  description: agentMcpSetEnabled.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMcpSetEnabledTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMcpSetEnabled.name, args, ctx, {
    surface: "mcp",
  });
  return agentMcpSetEnabled.output.parse(output);
}
