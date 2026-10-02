import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringMemoriesPromote } from "@oxagen/oxagen/contracts/steering.memories.promote";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringMemoriesPromote.input.shape };

export const metadata: ToolMetadata = {
  name: steeringMemoriesPromote.name,
  description: steeringMemoriesPromote.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function promoteMemoriesTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringMemoriesPromote.name, args, ctx, {
    surface: "mcp",
  });
  return steeringMemoriesPromote.output.parse(output);
}
