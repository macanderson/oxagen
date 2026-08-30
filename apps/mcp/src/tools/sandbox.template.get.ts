import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateGet } from "@oxagen/oxagen/contracts/sandbox.template.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateGet.name,
  description: sandboxTemplateGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function sandboxTemplateGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateGet.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateGet.output.parse(output);
}
