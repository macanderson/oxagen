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
    "turns: the steps grouped by turn; steps: one per model call and tool call, request and result folded together, and one per event such as a prompt or a decision; everything: one per frame",
  ),
  kinds: runTranscriptGet.input.shape.kinds.describe(
    "The chips to narrow to (prompt, responses, thinking, tools, policy, usage, recall, seal, errors), applied to the folded entries; empty keeps every entry",
  ),
  after: runTranscriptGet.input.shape.after.describe(
    "An entry cursor from an earlier read; omit to read from the start",
  ),
  limit: runTranscriptGet.input.shape.limit.describe(
    "Entries per page, 1 to 500",
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
