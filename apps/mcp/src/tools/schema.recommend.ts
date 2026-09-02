import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaRecommend } from "@oxagen/oxagen/contracts/schema.recommend";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaRecommend.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaRecommend.name,
  description: schemaRecommend.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function schemaRecommendTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaRecommend.name, args, ctx, {
    surface: "mcp",
  });
  return schemaRecommend.output.parse(output);
}
