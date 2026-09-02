import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTraceGet } from "@oxagen/oxagen/contracts/agent.trace.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentTraceGet.input.shape,
  executionId: agentTraceGet.input.shape.executionId.describe(
    "Public ID (aex_…) or UUID of the execution to fetch as a span tree",
  ),
};

export const metadata: ToolMetadata = {
  name: agentTraceGet.name,
  description: agentTraceGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentTraceGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentTraceGet.name, args, ctx, {
    surface: "mcp",
  });
  return agentTraceGet.output.parse(output);
}
