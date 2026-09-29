// schema.ts: the JSON Schema this package publishes, and where its file lives.
//
// schemas/done-record.v1.json is JSON Schema draft 2020-12, published at
// https://oxagen.sh/schemas/done-record/v1.json.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DONE_RECORD_SCHEMA } from "./types";

/** Where every published schema lives. */
export const SCHEMA_BASE_URL = "https://oxagen.sh/schemas/";

/** The done record schema's `$id`. */
export const DONE_RECORD_SCHEMA_URL = `${SCHEMA_BASE_URL}${DONE_RECORD_SCHEMA}.json`;

/** The file name of a schema id under schemas/: `done-record/v1` becomes `done-record.v1.json`. */
export function schemaFileName(id: string): string {
  return `${id.replace("/", ".")}.json`;
}

/** The directory that holds this package's schema files. */
export function schemasDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
}

/** The path of the done record schema file. */
export function doneRecordSchemaPath(): string {
  return join(schemasDir(), schemaFileName(DONE_RECORD_SCHEMA));
}
