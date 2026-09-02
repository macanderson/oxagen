import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateSetDefault } from "@oxagen/oxagen/contracts/sandbox.template.set_default";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateSetDefault.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateSetDefault.name,
  description: sandboxTemplateSetDefault.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function sandboxTemplateSetDefaultTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateSetDefault.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateSetDefault.output.parse(output);
}
