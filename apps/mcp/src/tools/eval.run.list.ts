import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalRunList } from "@oxagen/oxagen/contracts/eval.run.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalRunList.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalRunList.name,
  description: evalRunList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function evalRunListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalRunList.name, args, ctx, {
    surface: "mcp",
  });
  return evalRunList.output.parse(output);
}
