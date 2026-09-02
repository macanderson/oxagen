import { z } from "zod";
import { registerCapability } from "../registry";

// ── Nested schemas ────────────────────────────────────────────────────────────

const fieldTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "select",
  "boolean",
]);

export const fieldDescriptorSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: fieldTypeSchema,
  current: z.unknown(),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional(),
  required: z.boolean().optional(),
});

const fieldDiffSchema = z.object({
  name: z.string().min(1),
  current: z.unknown(),
  proposed: z.unknown(),
  changed: z.boolean(),
  reason: z.string().optional(),
});

// ── Contract registration ─────────────────────────────────────────────────────

export const formFill = registerCapability({
  name: "fill_form",
  domain: "form",
  description:
    "Generatively fill or suggest values for page-level form fields based on a natural-language instruction. " +
    "Returns per-field diffs — only fields the instruction implies are changed; all others are echoed unchanged.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "form",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** The URL route the form lives on (used for telemetry + system-prompt context). */
    route: z.string().min(1),
    /** Optional plain-text summary of the entity being edited, e.g. "Project: Oxagen v2, status: active". */
    entitySummary: z.string().optional(),
    /** The user's natural-language instruction, e.g. "Set the name to 'Acme Corp' and mark it active". */
    instruction: z.string().min(1),
    /** Every field on the form, including its current value. */
    fields: z.array(fieldDescriptorSchema).min(1),
  }),
  output: z.object({
    /** One entry per field in the input `fields` array, in the same order. */
    fields: z.array(fieldDiffSchema),
  }),
});

export type FormFillInput = z.output<typeof formFill.input>;
export type FormFillOutput = z.output<typeof formFill.output>;
