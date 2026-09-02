import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaVersionList } from "@oxagen/oxagen/contracts/schema.version.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaVersionList.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaVersionList.name,
  description: schemaVersionList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaVersionListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaVersionList.name, args, ctx, {
    surface: "mcp",
  });
  return schemaVersionList.output.parse(output);
}
