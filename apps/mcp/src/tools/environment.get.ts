import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { environmentGet } from "@oxagen/oxagen/contracts/environment.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...environmentGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: environmentGet.name,
  description: environmentGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function environmentGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(environmentGet.name, args, ctx, {
    surface: "mcp",
  });
  return environmentGet.output.parse(output);
}
