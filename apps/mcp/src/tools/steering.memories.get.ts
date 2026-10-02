import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringMemoriesGet } from "@oxagen/oxagen/contracts/steering.memories.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringMemoriesGet.input.shape };

export const metadata: ToolMetadata = {
  name: steeringMemoriesGet.name,
  description: steeringMemoriesGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function getWorkspaceMemoryTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringMemoriesGet.name, args, ctx, {
    surface: "mcp",
  });
  return steeringMemoriesGet.output.parse(output);
}
