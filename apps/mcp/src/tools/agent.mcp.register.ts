import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpRegister } from "@oxagen/oxagen/contracts/agent.mcp.register";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMcpRegister.input.shape,
  name: agentMcpRegister.input.shape.name.describe(
    "Human-readable name for the MCP server",
  ),
  transportType:
    agentMcpRegister.input.shape.transportType.describe("Transport protocol"),
  endpointUrl: agentMcpRegister.input.shape.endpointUrl.describe(
    "URL of the MCP server endpoint",
  ),
  authStrategy: agentMcpRegister.input.shape.authStrategy.describe(
    "Authentication strategy",
  ),
  authConfig: agentMcpRegister.input.shape.authConfig.describe(
    "Authentication configuration key/value pairs",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMcpRegister.name,
  description: agentMcpRegister.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMcpRegisterTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMcpRegister.name, args, ctx, {
    surface: "mcp",
  });
  return agentMcpRegister.output.parse(output);
}
