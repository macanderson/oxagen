import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaVersionDiff } from "@oxagen/oxagen/contracts/schema.version.diff";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaVersionDiff.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaVersionDiff.name,
  description: schemaVersionDiff.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaVersionDiffTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaVersionDiff.name, args, ctx, {
    surface: "mcp",
  });
  return schemaVersionDiff.output.parse(output);
}
