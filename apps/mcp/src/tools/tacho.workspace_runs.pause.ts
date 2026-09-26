import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pauseWorkspaceRuns } from "@oxagen/oxagen/contracts/tacho.workspace_runs.pause";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  reason: pauseWorkspaceRuns.input.shape.reason.describe(
    "Why every live run in the workspace is paused. Recorded on each command and on the audit event, and read by each run on resume",
  ),
};

export const metadata: ToolMetadata = {
  name: pauseWorkspaceRuns.name,
  description: pauseWorkspaceRuns.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function pauseWorkspaceRunsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const input = pauseWorkspaceRuns.input.parse(args);
  const output = await invoke(pauseWorkspaceRuns.name, input, ctx, {
    surface: "mcp",
  });
  return pauseWorkspaceRuns.output.parse(output);
}
