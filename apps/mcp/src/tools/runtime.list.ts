import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runtimeList } from "@oxagen/oxagen/contracts/runtime.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  id: runtimeList.input.shape.id.describe(
    "One runtime's id (rtm_…) to read it alone; leave out to list them all",
  ),
};

export const metadata: ToolMetadata = {
  name: runtimeList.name,
  description: runtimeList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runtimeListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runtimeList.name, args, ctx, {
    surface: "mcp",
  });
  return runtimeList.output.parse(output);
}
