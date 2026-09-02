import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalRunGet } from "@oxagen/oxagen/contracts/eval.run.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalRunGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalRunGet.name,
  description: evalRunGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function evalRunGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalRunGet.name, args, ctx, {
    surface: "mcp",
  });
  return evalRunGet.output.parse(output);
}
