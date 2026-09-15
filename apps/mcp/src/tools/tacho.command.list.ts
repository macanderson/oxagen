import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { tachoCommandList } from "@oxagen/oxagen/contracts/tacho.command.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...tachoCommandList.input.shape,
  runId: tachoCommandList.input.shape.runId.describe(
    "The run's public id: arun_… (evidence ledger) or tse_… (wrapped agent session)",
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
