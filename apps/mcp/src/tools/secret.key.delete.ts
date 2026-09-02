import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { secretKeyDelete } from "@oxagen/oxagen/contracts/secret.key.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...secretKeyDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: secretKeyDelete.name,
  description: secretKeyDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function secretKeyDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(secretKeyDelete.name, args, ctx, {
    surface: "mcp",
  });
  return secretKeyDelete.output.parse(output);
}
