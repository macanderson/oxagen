import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runFork } from "@oxagen/oxagen/contracts/run.fork";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: runFork.input.shape.runId.describe(
    "The evidence-ledger run's public id (arun_…); a wrapped session has no attempt to fork",
  ),
  fromSeq: runFork.input.shape.fromSeq.describe(
    "The last recorded frame the fork replays (run_seq, at least 1); the next model call runs live",
  ),
};

export const metadata: ToolMetadata = {
  name: runFork.name,
  description: runFork.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function runForkTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(runFork.name, args, ctx, { surface: "mcp" });
  return runFork.output.parse(output);
}
