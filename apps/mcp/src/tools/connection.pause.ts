import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionPause } from "@oxagen/oxagen/contracts/connection.pause";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...connectionPause.input.shape,
};

export const metadata: ToolMetadata = {
  name: connectionPause.name,
  description: connectionPause.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function connectionPauseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(connectionPause.name, args, ctx, {
    surface: "mcp",
  });
  return connectionPause.output.parse(output);
}
