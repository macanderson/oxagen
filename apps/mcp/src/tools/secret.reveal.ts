import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { secretReveal } from "@oxagen/oxagen/contracts/secret.reveal";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...secretReveal.input.shape,
};

export const metadata: ToolMetadata = {
  name: secretReveal.name,
  description: secretReveal.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function secretRevealTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(secretReveal.name, args, ctx, { surface: "mcp" });
  return secretReveal.output.parse(output);
}
