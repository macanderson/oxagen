// schema-ids.ts: the schema ids MCP Studio publishes.
//
// The four contract ids are in the steering repo's Shared contract, and
// packages/oxagen/src/steering-repo/schema-ids.ts lists them. The two wire
// ids are the gateway's signed envelopes. They never sit in a steering repo,
// but the relay and the local gateway validate against the same published
// JSON Schema the cloud gateway signs with.
import {
  SCHEMA_BASE_URL,
  type SchemaId,
} from "@oxagen/oxagen/steering-repo/schema-ids";

/** The Shared contract ids whose schema lives in this package. */
export const MCP_STUDIO_CONTRACT_SCHEMA_IDS = [
  "mcp-server/v1",
  "mcp-tools/v1",
  "mcp-tools-lock/v1",
  "tool-manifest/v1",
] as const satisfies readonly SchemaId[];
export type McpStudioContractSchemaId =
  (typeof MCP_STUDIO_CONTRACT_SCHEMA_IDS)[number];

/** The envelopes the cloud gateway signs for a relay and for a local gateway. */
export const MCP_STUDIO_WIRE_SCHEMA_IDS = [
  "relay-envelope/v1",
  "local-call-envelope/v1",
] as const;
export type McpStudioWireSchemaId =
  (typeof MCP_STUDIO_WIRE_SCHEMA_IDS)[number];

export type McpStudioSchemaId = McpStudioContractSchemaId | McpStudioWireSchemaId;

/** `https://oxagen.sh/schemas/<id>.json`, the schema's `$id`. */
export function mcpStudioSchemaUrl(id: McpStudioSchemaId): string {
  return `${SCHEMA_BASE_URL}${id}.json`;
}
