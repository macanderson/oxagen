import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { environmentList } from "@oxagen/oxagen/contracts/environment.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...environmentList.input.shape,
};

export const metadata: ToolMetadata = {
  name: environmentList.name,
  description: environmentList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function environmentListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(environmentList.name, args, ctx, {
    surface: "mcp",
  });
  return environmentList.output.parse(output);
}
