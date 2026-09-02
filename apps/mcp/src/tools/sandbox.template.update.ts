import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateUpdate } from "@oxagen/oxagen/contracts/sandbox.template.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateUpdate.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateUpdate.name,
  description: sandboxTemplateUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function sandboxTemplateUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateUpdate.output.parse(output);
}
