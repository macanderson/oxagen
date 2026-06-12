import { bigint, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { graphSchema } from "./_schemas";

// Transactional outbox for Neo4j graph projection.
// Written in the same Postgres transaction as domain rows — makes PG commit
// atomic with the *intent* to project. Inngest projector drains at-least-once
// with idempotent versioned MERGE, achieving effectively exactly-once delivery
// without distributed transactions. Neo4j is rebuildable from Postgres at any time.
export const graphOutbox = graphSchema.table(
  "outbox",
  {
    // bigint identity for strict total order — not UUID.
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    // 'upsert' = MERGE node/relationship; 'delete' = DETACH DELETE.
    op: text("op").notNull(),
    payload: jsonb("payload").notNull(),
    // Per-aggregate monotonic version for out-of-order guard in idempotent MERGE.
    version: bigint("version", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => ({
    pendingIdx: index("graph_outbox_pending_idx").on(t.id).where(sql`processed_at IS NULL`),
    aggregateIdx: index("graph_outbox_aggregate_idx").on(t.aggregateType, t.aggregateId),
    orgIdx: index("graph_outbox_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// High-water mark per projector for observability and replay targeting.
export const projectionCheckpoints = graphSchema.table(
  "projection_checkpoints",
  {
    projectorName: text("projector_name").primaryKey(),
    lastProcessedOutboxId: bigint("last_processed_outbox_id", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
