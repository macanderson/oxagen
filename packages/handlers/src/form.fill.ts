import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  formFill,
  type FormFillInput,
} from "@oxagen/oxagen/contracts/form.fill";
import { logger } from "./logger";

// Derive the field shape from the contract input so this file never drifts.
type FieldSpec = FormFillInput["fields"][number];

// ── Schema builder ────────────────────────────────────────────────────────────

/**
 * Build a flat Zod object schema whose keys mirror the input field names.
 * The model must return an object with exactly these keys and the right
 * primitive type for each field. Enum fields constrain to their option values.
 *
 * We also include a per-field `reason` key (nullable string) so the model
 * can provide a rationale for each change in one pass.
 */
function buildModelSchema(
  fields: FieldSpec[],
): z.ZodObject<
  Record<
    string,
    | z.ZodString
    | z.ZodNumber
    | z.ZodBoolean
    | z.ZodNullable<z.ZodString>
    | z.ZodEnum<[string, ...string[]]>
    | z.ZodNullable<z.ZodNumber>
    | z.ZodNullable<z.ZodBoolean>
  >
> {
  const shape: Record<
    string,
    | z.ZodString
    | z.ZodNumber
    | z.ZodBoolean
    | z.ZodNullable<z.ZodString>
    | z.ZodEnum<[string, ...string[]]>
    | z.ZodNullable<z.ZodNumber>
    | z.ZodNullable<z.ZodBoolean>
  > = {};

  for (const field of fields) {
    let valueSchema:
      | z.ZodString
      | z.ZodNumber
      | z.ZodBoolean
      | z.ZodNullable<z.ZodString>
      | z.ZodEnum<[string, ...string[]]>
      | z.ZodNullable<z.ZodNumber>
      | z.ZodNullable<z.ZodBoolean>;

    if (field.type === "select" && field.options && field.options.length > 0) {
      const values = field.options.map((o) => o.value) as [string, ...string[]];
      valueSchema = z.enum(values);
    } else if (field.type === "number") {
      valueSchema = z.number().nullable();
    } else if (field.type === "boolean") {
      valueSchema = z.boolean().nullable();
    } else {
      // text / textarea
      valueSchema = z.string().nullable();
    }

    shape[field.name] = valueSchema;
    // Per-field reason — always nullable so unchanged fields can omit it.
    shape[`${field.name}__reason`] = z.string().nullable();
  }

  return z.object(shape);
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(
  fields: FieldSpec[],
  instruction: string,
  entitySummary: string | undefined,
  route: string,
): string {
  const fieldLines = fields
    .map((f) => {
      const currentStr =
        f.current === null || f.current === undefined
          ? "(empty)"
          : JSON.stringify(f.current);
      const optionsStr =
        f.type === "select" && f.options
          ? ` [options: ${f.options.map((o) => `"${o.value}"`).join(", ")}]`
          : "";
      const requiredStr = f.required ? " (required)" : "";
      return `  • ${f.name} (${f.type}${optionsStr}${requiredStr}): label="${f.label}", current=${currentStr}`;
    })
    .join("\n");

  const contextLines = [
    `Route: ${route}`,
    entitySummary ? `Context: ${entitySummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "You are a form-fill assistant. Given a natural-language instruction and a list of form fields, ",
    "return the appropriate value for EVERY field.",
    "",
    "RULES:",
    "1. Only change fields that the instruction explicitly implies — echo all others with their current value.",
    "2. For each field also return a `<fieldName>__reason` key:",
    "   - If you changed the field: explain why (1 sentence).",
    "   - If you did NOT change the field: return null.",
    "3. Never invent values for fields the instruction does not address.",
    "4. For select fields you MUST return one of the listed option values — never an arbitrary string.",
    "5. For boolean fields return true or false (never a string).",
    "6. For number fields return a number (never a string).",
    "7. For text/textarea fields return a string (never null unless current is null and instruction does not imply a value).",
    "",
    contextLines,
    "",
    "Form fields:",
    fieldLines,
    "",
    `Instruction: ${instruction}`,
  ]
    .join("\n")
    .trim();
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const formFillHandler: CapabilityHandler<typeof formFill> = async (
  input,
  ctx,
) => {
  const fields = input.fields;

  // Build a schema the model must conform to.
  const modelSchema = buildModelSchema(fields);

  const systemPrompt = buildSystemPrompt(
    fields,
    input.instruction,
    input.entitySummary,
    input.route,
  );

  // The telemetry messageId falls back to the requestId so every call lands
  // in token_usage even when invoked outside an active chat turn.
  const messageId = ctx.messageId ?? ctx.requestId;

  let modelObject: z.infer<typeof modelSchema> | null = null;
  try {
    const result = await generateObjectFor({
      schema: modelSchema,
      system: systemPrompt,
      prompt: `Instruction: ${input.instruction}`,
      temperature: 0,
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId,
      },
    });
    modelObject = result.object;
  } catch (err) {
    // Model error → return all fields unchanged, no throw (policy §0.5).
    logger.warn(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "form.fill: generateObjectFor failed — returning fields unchanged",
    );
    return {
      fields: fields.map((f) => ({
        name: f.name,
        current: f.current,
        proposed: f.current,
        changed: false,
        reason: "Model error — field left unchanged.",
      })),
    };
  }

  // Compute per-field diffs from the model's response.
  const diffs = fields.map((f) => {
    const proposed = modelObject![f.name as keyof typeof modelObject];
    const reason =
      modelObject![`${f.name}__reason` as keyof typeof modelObject];

    // Strict equality check. null === null is intentionally fine here.
    const changed = proposed !== f.current;

    return {
      name: f.name,
      current: f.current,
      proposed: proposed,
      changed,
      ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
    };
  });

  return { fields: diffs };
};
