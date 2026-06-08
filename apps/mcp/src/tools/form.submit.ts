import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { formSubmit } from "@oxagen/oxagen/contracts/form.submit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...formSubmit.input.shape,
  form_id: formSubmit.input.shape.form_id.describe(
    "ID of the form to submit to",
  ),
  responses: formSubmit.input.shape.responses.describe(
    "Key-value map of field IDs to response values",
  ),
};

export const metadata: ToolMetadata = {
  name: formSubmit.name,
  description: formSubmit.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function formSubmitTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(formSubmit.name, args, ctx, { surface: "mcp" });
  return formSubmit.output.parse(output);
}
