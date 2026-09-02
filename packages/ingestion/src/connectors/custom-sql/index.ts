import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";

const queryDefinitionSchema = z.object({
  sourceRecordType: z.string().min(1),
  // Must include an `id` column used as externalId.
  // Use :cursor for incremental fetches, e.g.: WHERE updated_at > :cursor
  query: z.string().min(1),
  idColumn: z.string().default("id"),
  cursorColumn: z.string().optional(),
  displayNameColumn: z.string().optional(),
});

const connectionConfigSchema = z.object({
  queries: z.array(queryDefinitionSchema).min(1),
  pollIntervalSeconds: z.number().int().positive().default(900),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

const customSql: ConnectorDefinition<Config> = {
  connectorId: "custom-sql",
  displayName: "Custom SQL",
  description:
    "Sync records from any database using a connection string and custom SQL queries.",
  icon: "database",
  supportedAuthSchemes: ["connection_string"],
  deliveryMethod: "sql_query",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, config): Promise<RecordTypeSample[]> {
    return config.queries.map((q) => ({
      sourceRecordType: q.sourceRecordType,
      displayName: q.sourceRecordType,
      sampleRecords: [],
      fieldSchema: {},
    }));
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);
    // Generic passthrough: the customer configured the query and property mappings.
    // Convention: must have an id column for externalId.
    const id = r["id"] ?? r["ID"] ?? r["_id"] ?? r["pk"];
    const displayName =
      r["name"] ?? r["title"] ?? r["display_name"] ?? r["subject"];
    return {
      externalId: id != null ? String(id) : "",
      displayName: displayName != null ? String(displayName) : undefined,
      properties: { sourceRecordType, ...r },
    };
  },

  async *poll(_auth, _config, _recordType, _cursor) {
    throw new Error("custom-sql.poll: not yet implemented");
  },
};

registerConnector(customSql);

export { customSql };
