import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxFileRead } from "@oxagen/oxagen/contracts/agent.sandbox_file.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  sessionId: agentSandboxFileRead.input.shape.sessionId.describe(
    "Durable-session id (sbx_…) returned by start_sandbox.",
  ),
  path: agentSandboxFileRead.input.shape.path.describe(
    "Workspace-relative file to read (e.g. `src/index.ts`). Must not be absolute or contain `..` segments.",
  ),
  maxBytes: agentSandboxFileRead.input.shape.maxBytes.describe(
    "Maximum number of bytes to return (default 256 KiB, cap 1 MiB). Larger files come back truncated.",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxFileRead.name,
  description: agentSandboxFileRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSandboxFileReadTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxFileRead.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxFileRead.output.parse(output);
}
