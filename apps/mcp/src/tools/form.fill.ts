import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  formFill,
  fieldDescriptorSchema,
} from "@oxagen/oxagen/contracts/form.fill";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...formFill.input.shape,
  route: formFill.input.shape.route.describe(
    "URL route the form lives on (used for telemetry and context)",
  ),
  entitySummary: formFill.input.shape.entitySummary.describe(
    'Optional plain-text summary of the entity being edited, e.g. "Project: Acme, status: active"',
  ),
  instruction: formFill.input.shape.instruction.describe(
    'Natural-language instruction for how to fill the form, e.g. "Set the name to Acme Corp and mark it active"',
  ),
  fields: formFill.input.shape.fields.describe(
    "Every field on the form, including its current value",
  ),
};

// Re-export for consumers that need the field descriptor type.
export { fieldDescriptorSchema };

export const metadata: ToolMetadata = {
  name: formFill.name,
  description: formFill.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function formFillTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(formFill.name, args, ctx, { surface: "mcp" });
  return formFill.output.parse(output);
}
