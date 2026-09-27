import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...runGet.input.shape,
  runId: runGet.input.shape.runId.describe(
    "The run's public id: arun_… (evidence ledger) or tse_… (wrapped agent session)",
  ),
  framesAfter: runGet.input.shape.framesAfter.describe(
    "A frame or page cursor from an earlier read of the same chain; omit to read from the start",
  ),
  sessionUuid: runGet.input.shape.sessionUuid.describe(
    "The subagent chain to page, from a frame's or a chain head's sessionUuid; omit to page the run's own chain",
  ),
  chainsAfter: runGet.input.shape.chainsAfter.describe(
    "chains.cursor from an earlier read; with waitMs, the wait also ends when a subagent chain records a frame",
  ),
  frameLimit: runGet.input.shape.frameLimit.describe(
    "Max frames to return (1–500)",
  ),
  waitMs: runGet.input.shape.waitMs.describe(
    "Wait up to this long (0–20000 ms) for a frame past the cursor",
  ),
};

export const metadata: ToolMetadata = {
  name: runGet.name,
  description: runGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(runGet.name, args, ctx, { surface: "mcp" });
  return runGet.output.parse(output);
}
