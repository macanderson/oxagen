import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateCreate } from "@oxagen/oxagen/contracts/sandbox.template.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateCreate.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateCreate.name,
  description: sandboxTemplateCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function sandboxTemplateCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateCreate.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateCreate.output.parse(output);
}
