import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpConsentList } from "@oxagen/oxagen/contracts/agent.mcp_consent.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMcpConsentList.input.shape,
  mineOnly: agentMcpConsentList.input.shape.mineOnly.describe(
    "When true, return only the calling user's grants; default false returns all workspace grants",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMcpConsentList.name,
  description: agentMcpConsentList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMcpConsentListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMcpConsentList.name, args, ctx, {
    surface: "mcp",
  });
  return agentMcpConsentList.output.parse(output);
}
