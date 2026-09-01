import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextRecordList } from "@oxagen/oxagen/contracts/context.record.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...contextRecordList.input.shape,
  status: contextRecordList.input.shape.status.describe(
    "Only return records in this lifecycle status (active | retired | superseded)",
  ),
  limit: contextRecordList.input.shape.limit.describe(
    "Maximum number of records to return (default 50, max 200)",
  ),
  offset: contextRecordList.input.shape.offset.describe(
    "Pagination offset — number of records to skip",
  ),
};

export const metadata: ToolMetadata = {
  name: contextRecordList.name,
  description: contextRecordList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextRecordListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextRecordList.name, args, ctx, {
    surface: "mcp",
  });
  return contextRecordList.output.parse(output);
}
