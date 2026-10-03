import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionDelete } from "@oxagen/oxagen/contracts/connection.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...connectionDelete.input.shape };

export const metadata: ToolMetadata = {
  name: connectionDelete.name,
  description: connectionDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function connectionDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(connectionDelete.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(output);
}
