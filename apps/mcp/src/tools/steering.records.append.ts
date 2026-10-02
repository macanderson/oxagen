import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRecordsAppend } from "@oxagen/oxagen/contracts/steering.records.append";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringRecordsAppend.input.shape };

export const metadata: ToolMetadata = {
  name: steeringRecordsAppend.name,
  description: steeringRecordsAppend.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function steeringRecordsAppendTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRecordsAppend.name, args, ctx, {
    surface: "mcp",
  });
  return steeringRecordsAppend.output.parse(output);
}
