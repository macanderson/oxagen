import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextRecordsAppend } from "@oxagen/oxagen/contracts/context.records.append";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextRecordsAppend.input.shape };

export const metadata: ToolMetadata = {
  name: contextRecordsAppend.name,
  description: contextRecordsAppend.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextRecordsAppendTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextRecordsAppend.name, args, ctx, {
    surface: "mcp",
  });
  return contextRecordsAppend.output.parse(output);
}
