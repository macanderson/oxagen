import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { mandateRevoke } from "@oxagen/oxagen/contracts/mandate.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = {
  ...mandateRevoke.input.shape,
};

export const metadata: ToolMetadata = {
  name: mandateRevoke.name,
  description: mandateRevoke.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function mandateRevokeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(mandateRevoke.name, args, ctx, {
    surface: "mcp",
  });
  return mandateRevoke.output.parse(output);
}
