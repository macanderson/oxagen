import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { tachoCommandList } from "@oxagen/oxagen/contracts/tacho.command.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...tachoCommandList.input.shape,
  runId: tachoCommandList.input.shape.runId.describe(
    "The run whose commands to list: arun_… (evidence ledger) or tse_… (wrapped agent session). Send this or commandIds, not both",
  ),
  commandIds: tachoCommandList.input.shape.commandIds.describe(
    "The commands to list (tcm_…), such as the ids a broadcast dispatch_command returned. Send this or runId, not both. An id outside the workspace is left out. A steer held for an idle agent's next run comes back with agentKey set and runId null",
  ),
  limit: tachoCommandList.input.shape.limit.describe(
    "Max commands to return, newest first (1–100)",
  ),
};

export const metadata: ToolMetadata = {
  name: tachoCommandList.name,
  description: tachoCommandList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function listCommandsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(tachoCommandList.name, args, ctx, {
    surface: "mcp",
  });
  return tachoCommandList.output.parse(output);
}
