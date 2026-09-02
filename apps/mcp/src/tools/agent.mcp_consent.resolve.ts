import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpConsentResolve } from "@oxagen/oxagen/contracts/agent.mcp_consent.resolve";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMcpConsentResolve.input.shape,
  approvalId: agentMcpConsentResolve.input.shape.approvalId.describe(
    "The pending consent request id (the underlying approval row id) to resolve",
  ),
  decision: agentMcpConsentResolve.input.shape.decision.describe(
    "Whether to grant or deny first-use consent for the external MCP tool",
  ),
  grantAllTools: agentMcpConsentResolve.input.shape.grantAllTools.describe(
    "When true (and decision=granted), pre-grant every tool on the server rather than only the prompted tool",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMcpConsentResolve.name,
  description: agentMcpConsentResolve.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMcpConsentResolveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMcpConsentResolve.name, args, ctx, {
    surface: "mcp",
  });
  return agentMcpConsentResolve.output.parse(output);
}
