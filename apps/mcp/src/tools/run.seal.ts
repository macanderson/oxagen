import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runSeal } from "@oxagen/oxagen/contracts/run.seal";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: runSeal.input.shape.runId.describe(
    "The wrapped run to seal: a tse_… id as list_runs reports it. A ledger run (arun_…) is refused",
  ),
  reason: runSeal.input.shape.reason.describe(
    "Why you are sealing it; recorded on the kill command",
  ),
};

export const metadata: ToolMetadata = {
  name: runSeal.name,
  description: runSeal.description,
  annotations: {
    readOnlyHint: false,
    // The seal is final and the kill ends the agent's process.
    destructiveHint: true,
    // A second call on the same run is refused `run_sealed`.
    idempotentHint: false,
  },
};

export default async function runSealTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const input = runSeal.input.parse(args);
  const output = await invoke(runSeal.name, input, ctx, { surface: "mcp" });
  return runSeal.output.parse(output);
}
