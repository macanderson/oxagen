import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateImport } from "@oxagen/oxagen/contracts/sandbox.template.import";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateImport.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateImport.name,
  description: sandboxTemplateImport.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function sandboxTemplateImportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateImport.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateImport.output.parse(output);
}
