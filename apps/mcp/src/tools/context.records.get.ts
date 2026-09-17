import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextRecordsGet } from "@oxagen/oxagen/contracts/context.records.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextRecordsGet.input.shape };

export const metadata: ToolMetadata = {
  name: contextRecordsGet.name,
  description: contextRecordsGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextRecordsGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextRecordsGet.name, args, ctx, {
    surface: "mcp",
  });
  return contextRecordsGet.output.parse(output);
}
