import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxStop } from "@oxagen/oxagen/contracts/agent.sandbox.stop";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSandboxStop.input.shape,
  sessionId: agentSandboxStop.input.shape.sessionId.describe(
    "Durable-session id (sbx_…) returned by start_sandbox; terminates the container and releases all resources",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxStop.name,
  description: agentSandboxStop.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function agentSandboxStopTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxStop.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxStop.output.parse(output);
}
