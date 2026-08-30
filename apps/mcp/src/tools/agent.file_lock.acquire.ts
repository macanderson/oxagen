import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentFileLockAcquire } from "@oxagen/oxagen/contracts/agent.file_lock.acquire";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentFileLockAcquire.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentFileLockAcquire.name,
  description: agentFileLockAcquire.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentFileLockAcquireTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentFileLockAcquire.name, args, ctx, {
    surface: "mcp",
  });
  return agentFileLockAcquire.output.parse(output);
}
