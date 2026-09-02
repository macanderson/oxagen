import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxFilesList } from "@oxagen/oxagen/contracts/agent.sandbox_file.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  sessionId: agentSandboxFilesList.input.shape.sessionId.describe(
    "Durable-session id (sbx_…) returned by start_sandbox.",
  ),
  path: agentSandboxFilesList.input.shape.path.describe(
    "Workspace-relative directory to list (e.g. `src`). Omit to list the workspace root. Must not be absolute or contain `..` segments.",
  ),
  depth: agentSandboxFilesList.input.shape.depth.describe(
    "Maximum recursion depth below the listed directory (1-5). Defaults to 2.",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxFilesList.name,
  description: agentSandboxFilesList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSandboxFilesListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxFilesList.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxFilesList.output.parse(output);
}
