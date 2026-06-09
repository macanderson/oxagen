import { inngest } from "../inngest";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";

/**
 * Async deletion job triggered by `ingestion/connection.delete`.
 *
 * Three modes:
 *   connection_only  — soft-delete Postgres records only; leave Neo4j data.
 *   data_only        — remove Neo4j entity nodes; leave Postgres records.
 *   full             — remove both Neo4j nodes AND Postgres records.
 *
 * Case C alias promotion: when a principal node (created by this connection)
 * has ALIAS_OF edges from other connections, the highest-confidence alias is
 * promoted to become the new principal before the original is deleted.
 * This preserves the unified entity view across the remaining connections.
 *
 * Step 1: mark-deleting        update status → 'deleting'
 * Step 2: delete-neo4j-data    remove :EntityNode nodes + alias promotion (stub)
 * Step 3: delete-postgres      wipe mappings, credentials, webhook subs; mark deleted
 * Step 4: audit-log            write deletion event to ClickHouse
 */
export const ingestionDeleteConnection = inngest.createFunction(
  {
    id: "ingestion-delete-connection",
    retries: 2,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "ingestion/connection.delete" },
  async ({ event, step }) => {
    const { connectionId, orgId, workspaceId, mode, requestedBy, requestedAt } = event.data;

    // ── Step 1: Mark connection as 'deleting' ────────────────────────────────
    await step.run("mark-deleting", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx.execute(sql`
            UPDATE ingestion.source_connections
            SET    status     = 'deleting',
                   updated_at = NOW()
            WHERE  id      = ${connectionId}::uuid
            AND    org_id  = ${orgId}::uuid
          `),
        ),
      ),
    );

    // ── Step 2: Delete Neo4j entity nodes (when mode includes data) ──────────
    if (mode === "data_only" || mode === "full") {
      await step.run("delete-neo4j-data", async () => {
        // TODO(ingestion): implement Neo4j deletion via scopedSession()
        //
        // Algorithm:
        //   1. MATCH (n:EntityNode {connectionId: $connectionId, orgId: $orgId})
        //   2. For each n: check for incoming ALIAS_OF edges from nodes with
        //      a DIFFERENT connectionId (Case C: alias from another source).
        //      If found: promote highest-confidence alias to principal —
        //        - Copy n.naturalKey, n.displayName, n.properties → alias node
        //        - Reroute all ALIAS_OF edges that pointed to n → alias node
        //        - Remove n
        //      If not found: simply DETACH DELETE n
        //
        // Tracked in Linear: implement once scopedSession() is stable in this
        // execution context and alias-promotion cypher is reviewed.
        throw new Error(
          "ingestion-delete: Neo4j deletion not yet implemented — " +
            "tracked in Linear for implementation after scopedSession() stabilises",
        );
      });
    }

    // ── Step 3: Delete Postgres records ──────────────────────────────────────
    if (mode === "connection_only" || mode === "full") {
      await step.run("delete-postgres-records", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb(async (tx) => {
            // Delete child rows first (FK references source_connections.id).
            await tx.execute(sql`
              DELETE FROM ingestion.entity_type_mappings
              WHERE  connection_id = ${connectionId}::uuid
            `);
            await tx.execute(sql`
              DELETE FROM ingestion.setup_suggestions
              WHERE  connection_id = ${connectionId}::uuid
            `);
            await tx.execute(sql`
              DELETE FROM ingestion.webhook_subscriptions
              WHERE  connection_id = ${connectionId}::uuid
            `);
            await tx.execute(sql`
              DELETE FROM ingestion.auth_credentials
              WHERE  connection_id = ${connectionId}::uuid
            `);
            // Soft-delete the connection itself so audit history is preserved.
            await tx.execute(sql`
              UPDATE ingestion.source_connections
              SET    status     = 'deleted',
                     deleted_at = NOW(),
                     deleted_by = ${requestedBy}::uuid,
                     updated_at = NOW()
              WHERE  id     = ${connectionId}::uuid
              AND    org_id = ${orgId}::uuid
            `);
          }),
        ),
      );
    }

    // ── Step 4: Audit log ────────────────────────────────────────────────────
    await step.run("audit-log", async () => {
      // TODO(ingestion): write ClickHouse event via telemetry package once
      // the ingestion surface is wired into the telemetry schema.
      // For now: log locally so the deletion is traceable in Pino output.
      logger.info(
        { connectionId, orgId, workspaceId, mode, requestedBy, requestedAt },
        "ingestion-delete-connection: completed",
      );
    });

    return { connectionId, mode, deletedAt: new Date().toISOString() };
  },
);
