// json-schema.ts: the JSON Schema that GraphQL arguments and results map to.
import { isEnumType, type GraphQLLeafType } from "graphql";

/** The part of JSON Schema that GraphQL import writes. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: (string | null)[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
  deprecated?: boolean;
}

/** A JSON Schema whose type is object, as inputSchema and outputSchema must be. */
export type ObjectSchema = JsonSchema & { type: "object"; properties: Record<string, JsonSchema> };

const BUILT_IN_SCALARS = new Map<string, string>([
  ["Int", "integer"],
  ["Float", "number"],
  ["String", "string"],
  ["ID", "string"],
  ["Boolean", "boolean"],
]);

/**
 * An enum's values as a string enum, and a built-in scalar as its JSON type.
 * A custom scalar with no description is a string. A described one carries its
 * description and no type, because the description says what it holds.
 */
export function leafSchema(type: GraphQLLeafType): JsonSchema {
  if (isEnumType(type)) return { type: "string", enum: type.getValues().map((value) => value.name) };
  const builtIn = BUILT_IN_SCALARS.get(type.name);
  if (builtIn !== undefined) return { type: builtIn };
  const parts: string[] = [];
  if (type.description) parts.push(type.description);
  if (type.specifiedByURL) parts.push(`Format: ${type.specifiedByURL}`);
  return parts.length === 0 ? { type: "string" } : { description: parts.join("\n\n") };
}

/** The schema with null allowed. A schema with no type allows null already. */
export function orNull(schema: JsonSchema): JsonSchema {
  const out = { ...schema };
  if (typeof out.type === "string") out.type = [out.type, "null"];
  if (out.enum !== undefined) out.enum = [...out.enum, null];
  return out;
}

/** The schema with a field's or argument's description ahead of the type's own. */
export function withDescription(schema: JsonSchema, description: string | null | undefined): JsonSchema {
  if (!description) return schema;
  return {
    ...schema,
    description: schema.description === undefined ? description : `${description}\n\n${schema.description}`,
  };
}
