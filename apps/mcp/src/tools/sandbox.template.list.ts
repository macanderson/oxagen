import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { sandboxTemplateList } from "@oxagen/oxagen/contracts/sandbox.template.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...sandboxTemplateList.input.shape,
};

export const metadata: ToolMetadata = {
  name: sandboxTemplateList.name,
  description: sandboxTemplateList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function sandboxTemplateListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(sandboxTemplateList.name, args, ctx, {
    surface: "mcp",
  });
  return sandboxTemplateList.output.parse(output);
}
