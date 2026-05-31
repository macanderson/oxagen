import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpList } from "@oxagen/oxagen/contracts/agent.mcp.list";
import { agentMcpListHandler } from "@oxagen/agent/handlers/agent.mcp.list";
import { buildContext } from "../context.js";

export const schema = {};

export const metadata: ToolMetadata = {
  name: agentMcpList.name,
  description: agentMcpList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMcpListTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await agentMcpListHandler({}, ctx);
  return agentMcpList.output.parse(output);
}
