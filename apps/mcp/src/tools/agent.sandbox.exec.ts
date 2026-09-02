import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxExec } from "@oxagen/oxagen/contracts/agent.sandbox.exec";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSandboxExec.input.shape,
  sessionId: agentSandboxExec.input.shape.sessionId.describe(
    "Durable-session id (sbx_…) returned by start_sandbox",
  ),
  command: agentSandboxExec.input.shape.command.describe(
    "Shell command line executed via `sh -c` in the session workspace; filesystem/process state persists across calls",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxExec.name,
  description: agentSandboxExec.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function agentSandboxExecTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxExec.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxExec.output.parse(output);
}
