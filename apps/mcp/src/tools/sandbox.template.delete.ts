import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateDelete } from "@oxagen/oxagen/contracts/sandbox.template.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateDelete.name,
  description: sandboxTemplateDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function sandboxTemplateDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateDelete.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateDelete.output.parse(output);
}
