import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { formFill } from "@oxagen/oxagen/contracts/form.fill";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

const fieldDescriptorSchema = z.object({
  name: z.string().min(1).describe("Field identifier"),
  label: z.string().min(1).describe("Human-readable field label"),
  type: z
    .enum(["text", "textarea", "number", "select", "boolean"])
    .describe("Field input type"),
  current: z.unknown().describe("Current field value"),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe("Allowed values for select fields"),
  required: z.boolean().optional().describe("Whether the field is required"),
});

export const schema = {
  route: z
    .string()
    .min(1)
    .describe("URL route the form lives on (used for telemetry and context)"),
  entitySummary: z
    .string()
    .optional()
    .describe(
      "Optional plain-text summary of the entity being edited, e.g. \"Project: Acme, status: active\"",
    ),
  instruction: z
    .string()
    .min(1)
    .describe(
      "Natural-language instruction for how to fill the form, e.g. \"Set the name to Acme Corp and mark it active\"",
    ),
  fields: z
    .array(fieldDescriptorSchema)
    .min(1)
    .describe("Every field on the form, including its current value"),
};

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
