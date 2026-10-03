import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRecordList } from "@oxagen/oxagen/contracts/steering.record.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...steeringRecordList.input.shape,
  status: steeringRecordList.input.shape.status.describe(
    "Only return records in this lifecycle status (active | retired | superseded)",
  ),
  limit: steeringRecordList.input.shape.limit.describe(
    "Maximum number of records to return (default 50, max 200)",
  ),
  offset: steeringRecordList.input.shape.offset.describe(
    "Pagination offset — number of records to skip",
  ),
};

export const metadata: ToolMetadata = {
  name: steeringRecordList.name,
  description: steeringRecordList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function steeringRecordListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRecordList.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringRecordList.output.parse(output));
}
