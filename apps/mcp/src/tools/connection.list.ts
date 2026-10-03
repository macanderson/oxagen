import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...connectionList.input.shape };

export const metadata: ToolMetadata = {
  name: connectionList.name,
  description: connectionList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function connectionListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(connectionList.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(output);
}
