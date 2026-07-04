import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalRunStart } from "@oxagen/oxagen/contracts/eval.run.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalRunStart.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalRunStart.name,
  description: evalRunStart.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function evalRunStartTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalRunStart.name, args, ctx, {
    surface: "mcp",
  });
  return evalRunStart.output.parse(output);
}
