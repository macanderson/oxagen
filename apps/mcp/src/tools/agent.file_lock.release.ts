import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentFileLockRelease } from "@oxagen/oxagen/contracts/agent.file_lock.release";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentFileLockRelease.input.shape,
  lockId: agentFileLockRelease.input.shape.lockId.describe(
    "The lockId returned by acquire_file_lock or list_file_locks",
  ),
};

export const metadata: ToolMetadata = {
  name: agentFileLockRelease.name,
  description: agentFileLockRelease.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function agentFileLockReleaseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentFileLockRelease.name, args, ctx, {
    surface: "mcp",
  });
  return agentFileLockRelease.output.parse(output);
}
