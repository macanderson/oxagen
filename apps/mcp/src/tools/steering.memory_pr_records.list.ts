import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringMemoryPrRecordsList } from "@oxagen/oxagen/contracts/steering.memory_pr_records.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringMemoryPrRecordsList.input.shape };

export const metadata: ToolMetadata = {
  name: steeringMemoryPrRecordsList.name,
  description: steeringMemoryPrRecordsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function listMemoryPrRecordsTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringMemoryPrRecordsList.name, args, ctx, {
    surface: "mcp",
  });
  return steeringMemoryPrRecordsList.output.parse(output);
}
