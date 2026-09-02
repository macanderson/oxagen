import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateExport } from "@oxagen/oxagen/contracts/sandbox.template.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateExport.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateExport.name,
  description: sandboxTemplateExport.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function sandboxTemplateExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateExport.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateExport.output.parse(output);
}
