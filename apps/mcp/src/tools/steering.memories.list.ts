import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringMemoriesList } from "@oxagen/oxagen/contracts/steering.memories.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringMemoriesList.input.shape };

export const metadata: ToolMetadata = {
  name: steeringMemoriesList.name,
  description: steeringMemoriesList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function listWorkspaceMemoriesTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringMemoriesList.name, args, ctx, {
    surface: "mcp",
  });
  return steeringMemoriesList.output.parse(output);
}
