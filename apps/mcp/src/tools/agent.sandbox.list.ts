import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxList } from "@oxagen/oxagen/contracts/agent.sandbox.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  status: agentSandboxList.input.shape.status.describe(
    "Filter to sessions in this lifecycle status (running | idle | stopped | gone). Omit to include every non-deleted session.",
  ),
  limit: agentSandboxList.input.shape.limit.describe(
    "Maximum number of sessions to return (1-100). Defaults to 50.",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxList.name,
  description: agentSandboxList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSandboxListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxList.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxList.output.parse(output);
}
