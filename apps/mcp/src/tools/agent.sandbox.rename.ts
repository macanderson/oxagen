import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxRename } from "@oxagen/oxagen/contracts/agent.sandbox.rename";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSandboxRename.input.shape,
  sessionId: agentSandboxRename.input.shape.sessionId.describe(
    "Durable-session id (sbx_…) returned by start_sandbox; the session to relabel",
  ),
  label: agentSandboxRename.input.shape.label.describe(
    "New human-friendly display name for the sandbox (1-80 chars, shown in the sandbox list)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxRename.name,
  description: agentSandboxRename.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSandboxRenameTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxRename.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxRename.output.parse(output);
}
