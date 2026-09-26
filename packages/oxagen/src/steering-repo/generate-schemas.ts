// generate-schemas.ts: writes each steering repo schema as JSON Schema to
// packages/oxagen/schemas/<id>.json, with `$id`
// https://oxagen.sh/schemas/<id>.json.
//
//   pnpm exec tsx packages/oxagen/src/steering-repo/generate-schemas.ts
//
// A test renders every schema and compares it with the committed file, so a
// schema changed without running this fails CI.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toJsonSchema } from "./json-schema";
import { schemaUrl } from "./schema-ids";
import { STEERING_REPO_SCHEMAS, type SchemaEntry } from "./schemas";

/** Where the published schemas are committed. */
export const SCHEMAS_DIR = fileURLToPath(new URL("../../schemas", import.meta.url));

/** The draft every published schema follows. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** One schema as its committed file holds it, ending in a newline. */
export function renderSchemaFile(entry: SchemaEntry): string {
  const document = {
    $schema: JSON_SCHEMA_DIALECT,
    $id: schemaUrl(entry.id),
    title: entry.title,
    description: entry.description,
    ...toJsonSchema(entry.schema),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** `<id>.json`, relative to the schemas folder: `steering-record/v1.json`. */
export function schemaFilePath(entry: SchemaEntry): string {
  return `${entry.id}.json`;
}

/** Write every schema under `dir`. Returns the paths it wrote. */
export function writeSchemaFiles(dir: string = SCHEMAS_DIR): string[] {
  return STEERING_REPO_SCHEMAS.map((entry) => {
    const path = join(dir, schemaFilePath(entry));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSchemaFile(entry));
    return path;
  });
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  for (const path of writeSchemaFiles()) console.log(`wrote ${path}`);
}
