import { bigint, index, jsonb, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { integrationSchema } from "./_schemas.js";
import { auditMixin, executionStatusMixin, idMixin, softDeleteMixin, orgScopeMixin } from "./_mixins.js";

export const connections = integrationSchema.table(
  "connections",
  {
    ...idMixin("con"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    credentialId: uuid("credential_id"),
    status: text("status").notNull(),
    syncEnabled: boolean("sync_enabled").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "date" }),
    config: jsonb("config").notNull(),
  },
  (t) => ({
    orgIdx: index("connections_org_idx").on(t.orgId, t.workspaceId),
    providerIdx: index("connections_provider_idx").on(t.orgId, t.provider),
  }),
);

export const connectionSyncJobs = integrationSchema.table(
  "connection_sync_jobs",
  {
    ...idMixin("src"),
    ...executionStatusMixin(),
    connectionId: uuid("connection_id").notNull(),
    startedCursor: text("started_cursor"),
    completedCursor: text("completed_cursor"),
    // default uses sql`0` not BigInt 0n to avoid drizzle-kit snapshot-
    // serialization bug (BigInt in JSON.stringify) affecting drizzle-kit ≤0.31.
    recordsProcessed: bigint("records_processed", { mode: "bigint" }).notNull().default(sql`0`),
    errorPayload: jsonb("error_payload"),
  },
  (t) => ({
    connectionIdx: index("connection_sync_jobs_connection_idx").on(t.connectionId),
    statusIdx: index("connection_sync_jobs_status_idx").on(t.status),
  }),
);
