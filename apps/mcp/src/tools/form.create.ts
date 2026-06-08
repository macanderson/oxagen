import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { formCreate } from "@oxagen/oxagen/contracts/form.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...formCreate.input.shape,
  title: formCreate.input.shape.title.describe(
    "Form title",
  ),
  fields: formCreate.input.shape.fields.describe(
    "Array of field definition objects (optional)",
  ),
};

export const metadata: ToolMetadata = {
  name: formCreate.name,
  description: formCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function formCreateTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(formCreate.name, args, ctx, { surface: "mcp" });
  return formCreate.output.parse(output);
}
