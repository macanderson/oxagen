import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { secretValueUnset } from "@oxagen/oxagen/contracts/secret.value.unset";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...secretValueUnset.input.shape,
};

export const metadata: ToolMetadata = {
  name: secretValueUnset.name,
  description: secretValueUnset.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function secretValueUnsetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(secretValueUnset.name, args, ctx, {
    surface: "mcp",
  });
  return secretValueUnset.output.parse(output);
}
