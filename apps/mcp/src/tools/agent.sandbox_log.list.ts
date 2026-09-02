import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxLogsList } from "@oxagen/oxagen/contracts/agent.sandbox_log.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  sessionId: agentSandboxLogsList.input.shape.sessionId.describe(
    "Durable-session id (sbx_…) returned by start_sandbox.",
  ),
  level: agentSandboxLogsList.input.shape.level.describe(
    "Verbosity filter: 'normal' returns only program output (debug toggle OFF); omit for all lines.",
  ),
  limit: agentSandboxLogsList.input.shape.limit.describe(
    "Max lines returned (the newest N, in chronological order). Defaults to 500.",
  ),
  sinceMs: agentSandboxLogsList.input.shape.sinceMs.describe(
    "Epoch-ms floor on the line timestamp; defaults to 24h ago.",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxLogsList.name,
  description: agentSandboxLogsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSandboxLogsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxLogsList.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxLogsList.output.parse(output);
}
