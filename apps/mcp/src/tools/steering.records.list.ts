import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRecordsList } from "@oxagen/oxagen/contracts/steering.records.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringRecordsList.input.shape };

export const metadata: ToolMetadata = {
  name: steeringRecordsList.name,
  description: steeringRecordsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function steeringRecordsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRecordsList.name, args, ctx, {
    surface: "mcp",
  });
  return steeringRecordsList.output.parse(output);
}
