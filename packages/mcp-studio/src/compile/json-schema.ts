// json-schema.ts: the JSON Schema reads compile and diff share.
//
// A schema here is whatever the upstream sent, so each read checks the shape
// it needs and treats anything else as absent. compile/index.ts does not
// re-export these, so they stay out of the package's public names.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {};
}

export function requiredOf(schema: Record<string, unknown>): string[] {
  if (!Array.isArray(schema.required)) return [];
  return schema.required.filter((name): name is string => typeof name === "string");
}

/** Sets required, or deletes it when nothing is left, as the source schema would have. */
export function setRequired(schema: Record<string, unknown>, required: string[]): void {
  if (required.length > 0) schema.required = required;
  else delete schema.required;
}
