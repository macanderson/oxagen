import { z } from "zod";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";

/** §5.1 — field-level validation error. Codes: required|min|max|minItems|maxItems|pattern|type|oneOf|unknown */
export const fieldErrorSchema = z.object({
  field: z.string().describe("Dot-path to the invalid field"),
  message: z.string().describe("Human-readable validation error message"),
  code: z
    .enum([
      "required",
      "min",
      "max",
      "minItems",
      "maxItems",
      "pattern",
      "type",
      "oneOf",
      "unknown",
    ])
    .describe("Machine-readable validation rule that failed"),
});
export type FieldError = z.output<typeof fieldErrorSchema>;

/** §4.6 — data types allowed for schema properties. */
export const dataTypeEnum = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "url",
  "email",
  "enum",
  "json",
  "array",
]);
export type DataType = z.output<typeof dataTypeEnum>;

/** §4.6 — validation constraints bag. */
export const constraintsSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    pattern: z.string().optional(),
  })
  .describe(
    "Validation constraints mirroring the connector FieldValidation shape",
  );

/** §5.2 — shared property input shape for label.upsert / relationship.upsert. */
export const propertyInputSchema = z.object({
  key: z.string().min(1).max(200).describe("Property name"),
  dataType: dataTypeEnum,
  required: z.boolean().default(false),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe("Grounding description for the extraction AI"),
  enumValues: z
    .array(z.string())
    .optional()
    .describe("When dataType='enum', the allowed values"),
  itemType: z
    .string()
    .optional()
    .describe("When dataType='array', the element type"),
  constraints: constraintsSchema.optional(),
  example: z
    .string()
    .optional()
    .describe("Few-shot grounding example for the extraction prompt"),
});
export type PropertyInput = z.output<typeof propertyInputSchema>;

/** Cardinality constraint for relationship types. */
export const cardinalityEnum = z.enum([
  "one_to_one",
  "one_to_many",
  "many_to_many",
]);

/** Schema source (who created it). */
export const schemaSourceEnum = z.enum(["user", "connector", "recommended"]);

/** Per-workspace enforcement mode for property validation. */
export const enforcementModeEnum = z.enum(["strict", "lenient", "off"]);

/** Relationship type validated by the lexical guard. */
export const relationshipTypeNameSchema = z
  .string()
  .regex(
    RELATIONSHIP_TYPE_PATTERN,
    "Relationship type must match ^[A-Z][A-Z0-9_]{0,62}$",
  );
