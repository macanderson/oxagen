import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateSetTools } from "@oxagen/oxagen/contracts/sandbox.template.set_tools";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateSetTools.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateSetTools.name,
  description: sandboxTemplateSetTools.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function sandboxTemplateSetToolsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateSetTools.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateSetTools.output.parse(output);
}
