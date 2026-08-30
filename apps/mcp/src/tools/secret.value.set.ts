import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { secretValueSet } from "@oxagen/oxagen/contracts/secret.value.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...secretValueSet.input.shape,
};

export const metadata: ToolMetadata = {
  name: secretValueSet.name,
  description: secretValueSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function secretValueSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(secretValueSet.name, args, ctx, {
    surface: "mcp",
  });
  return secretValueSet.output.parse(output);
}
