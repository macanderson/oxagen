import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runFrameBodyGet } from "@oxagen/oxagen/contracts/run.frame_body.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: runFrameBodyGet.input.shape.runId.describe(
    "The run's public id: arun_… (evidence ledger) or tse_… (wrapped agent session)",
  ),
  seq: runFrameBodyGet.input.shape.seq.describe(
    "The frame's sequence as get_run reports it (run_seq for a ledger run, seq for a wrapped session)",
  ),
  sessionUuid: runFrameBodyGet.input.shape.sessionUuid.describe(
    "The subagent chain the frame was recorded on, as get_run_transcript names it (sessionUuid on a half or entry). Omit it for the run's own chain",
  ),
};

export const metadata: ToolMetadata = {
  name: runFrameBodyGet.name,
  description: runFrameBodyGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runFrameBodyGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runFrameBodyGet.name, args, ctx, {
    surface: "mcp",
  });
  return runFrameBodyGet.output.parse(output);
}
