// schema-ids.ts: the schema ids of the Shared contract and where each one is
// published. Imports nothing.
//
// This module defines a schema for each id in STEERING_REPO_SCHEMA_IDS. Lane
// M0 defines the four MCP Studio ids (`mcp-server/v1`, `mcp-tools/v1`,
// `mcp-tools-lock/v1`, and `tool-manifest/v1`) in `packages/mcp-studio`.

/** Every schema id in the Shared contract, in the order the spec lists them. */
export const SCHEMA_IDS = [
  "steering-record/v1",
  "workspace/v1",
  "agent/v1",
  "governance/v1",
  "toolbelt/v1",
  "mcp-server/v1",
  "mcp-tools/v1",
  "mcp-tools-lock/v1",
  "tool-manifest/v1",
  "reflection/v1",
  "promotion/v1",
  "bundle/v1",
] as const;
export type SchemaId = (typeof SCHEMA_IDS)[number];

/** The ids whose schema lives in this module, not in MCP Studio. */
export const STEERING_REPO_SCHEMA_IDS = [
  "steering-record/v1",
  "workspace/v1",
  "agent/v1",
  "governance/v1",
  "toolbelt/v1",
  "reflection/v1",
  "promotion/v1",
  "bundle/v1",
] as const satisfies readonly SchemaId[];
export type SteeringRepoSchemaId = (typeof STEERING_REPO_SCHEMA_IDS)[number];

/** Every schema is published under this prefix. */
export const SCHEMA_BASE_URL = "https://oxagen.sh/schemas/";

/** `https://oxagen.sh/schemas/<id>.json`, the schema's `$id`. */
export function schemaUrl(id: SchemaId): string {
  return `${SCHEMA_BASE_URL}${id}.json`;
}

/** The first line of every TOML file in a steering repo: `#:schema <url>`. */
export function schemaDirective(id: SchemaId): string {
  return `#:schema ${schemaUrl(id)}`;
}

/**
 * The schema id a TOML file's first line names, or null when the first line
 * is not a `#:schema` directive for a contract schema.
 */
export function readSchemaDirective(text: string): SchemaId | null {
  const first = text.split("\n", 1)[0] as string;
  const prefix = `#:schema ${SCHEMA_BASE_URL}`;
  if (!first.startsWith(prefix) || !first.endsWith(".json")) return null;
  const id = first.slice(prefix.length, -".json".length);
  return (SCHEMA_IDS as readonly string[]).includes(id)
    ? (id as SchemaId)
    : null;
}
