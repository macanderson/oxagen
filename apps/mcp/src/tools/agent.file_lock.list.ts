import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentFileLockList } from "@oxagen/oxagen/contracts/agent.file_lock.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentFileLockList.input.shape,
};

export const metadata: ToolMetadata = {
  name: agentFileLockList.name,
  description: agentFileLockList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentFileLockListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentFileLockList.name, args, ctx, {
    surface: "mcp",
  });
  return agentFileLockList.output.parse(output);
}
