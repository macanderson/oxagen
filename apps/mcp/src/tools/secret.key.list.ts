import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { secretKeyList } from "@oxagen/oxagen/contracts/secret.key.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...secretKeyList.input.shape,
};

export const metadata: ToolMetadata = {
  name: secretKeyList.name,
  description: secretKeyList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function secretKeyListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(secretKeyList.name, args, ctx, {
    surface: "mcp",
  });
  return secretKeyList.output.parse(output);
}
