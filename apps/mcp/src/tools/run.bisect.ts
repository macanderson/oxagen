import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runBisect } from "@oxagen/oxagen/contracts/run.bisect";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runA: runBisect.input.shape.runA.describe(
    "The first run's public id (arun_… or tse_…)",
  ),
  runB: runBisect.input.shape.runB.describe(
    "The second run's public id (arun_… or tse_…)",
  ),
};

export const metadata: ToolMetadata = {
  name: runBisect.name,
  description: runBisect.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runBisectTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(runBisect.name, args, ctx, { surface: "mcp" });
  return runBisect.output.parse(output);
}
