import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: runTranscriptGet.input.shape.runId.describe(
    "The run's public id: arun_… (evidence ledger) or tse_… (wrapped agent session)",
  ),
  zoom: runTranscriptGet.input.shape.zoom.describe(
    "turns: one entry per turn; steps: one per model call and tool call; everything: one per frame",
  ),
};

export const metadata: ToolMetadata = {
  name: runTranscriptGet.name,
  description: runTranscriptGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runTranscriptGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runTranscriptGet.name, args, ctx, {
    surface: "mcp",
  });
  return runTranscriptGet.output.parse(output);
}
