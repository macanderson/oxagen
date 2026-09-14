import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runSummarize } from "@oxagen/oxagen/contracts/run.summarize";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: runSummarize.input.shape.runId.describe(
    "The sealed run's public id: arun_… (evidence ledger) or tse_… (wrapped agent session)",
  ),
};

export const metadata: ToolMetadata = {
  name: runSummarize.name,
  description: runSummarize.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runSummarizeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runSummarize.name, args, ctx, {
    surface: "mcp",
  });
  return runSummarize.output.parse(output);
}
