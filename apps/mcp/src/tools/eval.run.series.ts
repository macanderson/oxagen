import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalRunSeries } from "@oxagen/oxagen/contracts/eval.run.series";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalRunSeries.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalRunSeries.name,
  description: evalRunSeries.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function evalRunSeriesTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalRunSeries.name, args, ctx, {
    surface: "mcp",
  });
  return evalRunSeries.output.parse(output);
}
