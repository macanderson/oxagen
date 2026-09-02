import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxSnapshot } from "@oxagen/oxagen/contracts/agent.sandbox.snapshot";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSandboxSnapshot.input.shape,
  sessionId: agentSandboxSnapshot.input.shape.sessionId.describe(
    "Durable-session id (sbx_…) returned by start_sandbox; cannot snapshot while a command is mid-flight",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxSnapshot.name,
  description: agentSandboxSnapshot.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSandboxSnapshotTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxSnapshot.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxSnapshot.output.parse(output);
}
