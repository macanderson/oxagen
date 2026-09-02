import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionGet } from "@oxagen/oxagen/contracts/connection.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...connectionGet.input.shape };

export const metadata: ToolMetadata = {
  name: connectionGet.name,
  description: connectionGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function connectionGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionGet.name, args, ctx, { surface: "mcp" });
}
