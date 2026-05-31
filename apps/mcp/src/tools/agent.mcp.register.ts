import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpRegister } from "@oxagen/oxagen/contracts/agent.mcp.register";
import { agentMcpRegisterHandler } from "@oxagen/agent/handlers/agent.mcp.register";
import { buildContext } from "../context.js";

export const schema = {
  name: z.string().min(1).max(120).describe("Human-readable name for the MCP server"),
  transportType: z.enum(["streamable-http", "stdio"]).describe("Transport protocol"),
  endpointUrl: z.string().url().describe("URL of the MCP server endpoint"),
  authStrategy: z
    .enum(["none", "bearer", "header"])
    .default("none")
    .describe("Authentication strategy"),
  authConfig: z
    .record(z.string())
    .optional()
    .describe("Authentication configuration key/value pairs"),
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
  const output = await agentMcpRegisterHandler(args, ctx);
  return agentMcpRegister.output.parse(output);
}
