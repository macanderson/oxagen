import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextRecordsList.input.shape };

export const metadata: ToolMetadata = {
  name: contextRecordsList.name,
  description: contextRecordsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextRecordsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextRecordsList.name, args, ctx, {
    surface: "mcp",
  });
  return contextRecordsList.output.parse(output);
}
