import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";

const connectionConfigSchema = z.object({
  projectId: z.string().min(1),
  datasetId: z.string().min(1),
  // SQL query to execute; must include an updated_at-style column for cursor-based polling.
  query: z.string().min(1),
  // Column name used as the polling cursor (e.g. "updated_at", "created_at").
  cursorColumn: z.string().default("updated_at"),
  // Maps query result columns to source record types.
  recordType: z.string().min(1),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const googleBigQuery: ConnectorDefinition<Config> = {
  connectorId: "google-bigquery",
  displayName: "Google BigQuery",
  description:
    "Query rows from BigQuery datasets and sync them into the context graph.",
  icon: "bigquery",
  supportedAuthSchemes: ["oauth2_authorization_code", "service_account_json"],
  deliveryMethod: "sql_query",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("google-bigquery.previewRecordTypes: not yet implemented");
  },

  // connector treats all rows as the configured recordType — sourceRecordType unused.
  normalizeRecord(_sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);
    // BigQuery rows are free-form — pass all columns through as properties.
    // The customer's property mapping config handles field renaming.
    const id =
      asString(r["id"]) ?? asString(r["_id"]) ?? JSON.stringify(r).slice(0, 64);
    return {
      externalId: id,
      displayName:
        asString(r["name"]) ?? asString(r["title"]) ?? asString(r["label"]),
      properties: Object.fromEntries(
        Object.entries(r).filter(([, v]) => v !== null && v !== undefined),
      ),
    };
  },
};

registerConnector(googleBigQuery);

export { googleBigQuery };
