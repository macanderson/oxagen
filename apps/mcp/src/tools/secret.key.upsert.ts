import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { secretKeyUpsert } from "@oxagen/oxagen/contracts/secret.key.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...secretKeyUpsert.input.shape,
};

export const metadata: ToolMetadata = {
  name: secretKeyUpsert.name,
  description: secretKeyUpsert.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function secretKeyUpsertTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(secretKeyUpsert.name, args, ctx, {
    surface: "mcp",
  });
  return secretKeyUpsert.output.parse(output);
}
