// schemas.ts: the JSON Schemas this package publishes, and where their files live.
//
// Each file under schemas/ is JSON Schema draft 2020-12, published at
// https://oxagen.sh/schemas/<id>.json. done-record/v1 lives in
// @oxagen/done-record, which owns the base URL and the file naming.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_BASE_URL, schemaFileName } from "@oxagen/done-record";
import {
  COLLECTOR_SCHEMA,
  TRAINING_EXAMPLE_SCHEMA,
  TRIAGE_SCHEMA,
  WORK_FILE_SCHEMA,
  WORKFLOW_SCHEMA,
} from "./types";

/** The schema ids this package publishes. */
export const WORK_SCHEMA_IDS = [
  COLLECTOR_SCHEMA,
  WORK_FILE_SCHEMA,
  WORKFLOW_SCHEMA,
  TRIAGE_SCHEMA,
  TRAINING_EXAMPLE_SCHEMA,
] as const;
export type WorkSchemaId = (typeof WORK_SCHEMA_IDS)[number];

/** A schema's `$id`: `triage/v1` becomes https://oxagen.sh/schemas/triage/v1.json. */
export function schemaUrl(id: WorkSchemaId): string {
  return `${SCHEMA_BASE_URL}${id}.json`;
}

/** The directory that holds this package's schema files. */
export function workSchemasDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
}

/** The path of one schema file. */
export function workSchemaPath(id: WorkSchemaId): string {
  return join(workSchemasDir(), schemaFileName(id));
}
