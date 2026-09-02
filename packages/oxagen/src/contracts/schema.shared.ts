import { z } from "zod";

export const FieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
  code: z.enum([
    "required",
    "min",
    "max",
    "minItems",
    "maxItems",
    "pattern",
    "type",
    "oneOf",
    "unknown",
  ]),
});

export const PropertyInputSchema = z.object({
  key: z.string().min(1),
  dataType: z.enum([
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
  ]),
  required: z.boolean().default(false),
  description: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  itemType: z.string().optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  example: z.string().optional(),
});

export type FieldError = z.output<typeof FieldErrorSchema>;
export type PropertyInput = z.output<typeof PropertyInputSchema>;
