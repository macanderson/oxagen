import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runChainGet } from "@oxagen/oxagen/contracts/run.chain.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: runChainGet.input.shape.runId.describe(
    "The run's public id: arun_… (evidence ledger) or tse_… (wrapped agent session)",
  ),
};

export const metadata: ToolMetadata = {
  name: runChainGet.name,
  description: runChainGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runChainGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runChainGet.name, args, ctx, { surface: "mcp" });
  return runChainGet.output.parse(output);
}
