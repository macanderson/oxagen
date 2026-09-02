import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDebugTrace } from "@oxagen/oxagen/contracts/agent.debug.trace";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDebugTrace.input.shape,
  executionId: agentDebugTrace.input.shape.executionId.describe(
    "Public ID (aex_…) or UUID of the failed execution to diagnose",
  ),
  summarize: agentDebugTrace.input.shape.summarize.describe(
    "When true, also run one model call to produce a root-cause diagnosis (default: deterministic frame only)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentDebugTrace.name,
  description: agentDebugTrace.description,
  annotations: {
    // Read-only introspection; summarize:true adds a model call but mutates
    // nothing, so it stays non-destructive. Not idempotent because the optional
    // model narrative can vary between calls.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentDebugTraceTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDebugTrace.name, args, ctx, {
    surface: "mcp",
  });
  return agentDebugTrace.output.parse(output);
}
