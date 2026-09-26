// schemas.ts: every schema MCP Studio publishes, and the files that hold them.
//
// Each schema is written as JSON Schema (draft 2020-12) to
// packages/mcp-studio/schemas/<id>.json, with `$id`
// https://oxagen.sh/schemas/<id>.json. scripts/generate-schemas.ts writes
// them. A test renders every schema and compares it with the committed file,
// so a schema changed without running the generator fails CI.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { toJsonSchema } from "@oxagen/oxagen/steering-repo/json-schema";
import { localCallEnvelopeSchema } from "./local-call-envelope";
import { relayEnvelopeSchema } from "./relay-envelope";
import { mcpStudioSchemaUrl, type McpStudioSchemaId } from "./schema-ids";

export interface McpStudioSchemaEntry {
  id: McpStudioSchemaId;
  title: string;
  description: string;
  schema: z.ZodTypeAny;
}

/** Every published schema, in the order the generator writes them. */
export const MCP_STUDIO_SCHEMAS: readonly McpStudioSchemaEntry[] = [
  {
    id: "relay-envelope/v1",
    title: "Relay envelope",
    description:
      "One request the cloud gateway decided and signed for a relay inside a private network.",
    schema: relayEnvelopeSchema,
  },
  {
    id: "local-call-envelope/v1",
    title: "Local call envelope",
    description:
      "One call to a local server that the cloud gateway decided and signed for the local gateway.",
    schema: localCallEnvelopeSchema,
  },
];

/** Where the published schemas are committed: packages/mcp-studio/schemas. */
export const SCHEMAS_DIR = fileURLToPath(new URL("../../schemas", import.meta.url));

/** The draft every published schema follows. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** One schema as its committed file holds it, ending in a newline. */
export function renderSchemaFile(entry: McpStudioSchemaEntry): string {
  const document = {
    $schema: JSON_SCHEMA_DIALECT,
    $id: mcpStudioSchemaUrl(entry.id),
    title: entry.title,
    ...toJsonSchema(entry.schema),
    description: entry.description,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** `<id>.json`, relative to the schemas folder: `mcp-server/v1.json`. */
export function schemaFilePath(entry: McpStudioSchemaEntry): string {
  return `${entry.id}.json`;
}

/** Write every schema under `dir`. Returns the paths it wrote. */
export function writeSchemaFiles(dir: string = SCHEMAS_DIR): string[] {
  return MCP_STUDIO_SCHEMAS.map((entry) => {
    const path = join(dir, schemaFilePath(entry));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSchemaFile(entry));
    return path;
  });
}
