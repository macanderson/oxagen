 
import { createFunction } from "../create-function";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology";
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
export const [ingestionDeleteConnection] = createFunction(
  {
    id: "ingestion-delete-connection",
    retries: 2,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "ingestion/connection.delete" },
  async ({ event, step }) => {
    const { connectionId, orgId, workspaceId, mode, requestedBy, requestedAt } = event.data as {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      mode: string;
      requestedBy: string;
      requestedAt: string;
    };

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
      await step.run("delete-neo4j-data", () =>
        runInTenantScope({ orgId, workspaceId }, async () => {
          const session = scopedSession();

          // ── Pass 1: Promote aliases ──────────────────────────────────────
          // Find principal nodes (from this connection) that have incoming
          // ALIAS_OF edges from OTHER connections. Promote the highest-
          // confidence alias to become the new principal before deletion.
          const aliasResult = await session.run(
            `
            MATCH (alias:EntityNode)-[r:ALIAS_OF]->(principal:EntityNode)
            WHERE principal.connectionId = $connectionId
              AND principal.orgId = $orgId
              AND alias.connectionId <> $connectionId
            WITH principal, alias, r
            ORDER BY r.confidence DESC
            WITH principal, collect({alias: alias, edge: r})[0] AS topAlias
            WHERE topAlias IS NOT NULL
            WITH principal, topAlias.alias AS promoted
            // Copy principal's identity fields to the promoted alias
            SET promoted.naturalKey  = principal.naturalKey,
                promoted.displayName = principal.displayName,
                promoted.properties  = principal.properties,
                promoted.syncedAt    = datetime()
            // Reroute any remaining ALIAS_OF edges that pointed to the principal
            WITH principal, promoted
            MATCH (other:EntityNode)-[old:ALIAS_OF]->(principal)
            WHERE other <> promoted
            MERGE (other)-[newEdge:ALIAS_OF]->(promoted)
              ON CREATE SET newEdge.confidence  = old.confidence,
                            newEdge.matchReason = old.matchReason,
                            newEdge.tentative   = old.tentative,
                            newEdge.createdAt   = old.createdAt
            DELETE old
            RETURN count(promoted) AS promoted
            `,
            { connectionId, orgId },
          );

          const promotedCount = (aliasResult.records[0]?.get("promoted") as number | undefined) ?? 0;
          logger.info(
            { connectionId, orgId, promotedCount },
            "ingestion-delete: alias promotion complete",
          );

          // ── Pass 2: Delete non-aliased entity nodes ──────────────────────
          // Only delete nodes that have no remaining incoming ALIAS_OF edges
          // from other connections (they were either promoted above or were
          // never aliased).
          const deleteResult = await session.run(
            `
            MATCH (n:EntityNode {connectionId: $connectionId, orgId: $orgId})
            WHERE NOT ((:EntityNode)-[:ALIAS_OF]->(n))
            DETACH DELETE n
            RETURN count(n) AS deleted
            `,
            { connectionId, orgId },
          );

          const deletedCount = (deleteResult.records[0]?.get("deleted") as number | undefined) ?? 0;

          // ── Pass 3: Delete the code-graph nodes this connection produced ──
          // SourceFile + SourceSymbol nodes each carry connectionId and are NOT
          // part of the EntityNode ALIAS_OF graph, so they're removed
          // unconditionally. They were skipped before — meaning a "delete data"
          // left thousands of orphaned :KnowledgeNode files/symbols in the graph
          // after the connection was gone. DETACH DELETE also drops their
          // CONTAINS / SOURCED_FROM edges.
          const sourceDeleteResult = await session.run(
            `
            MATCH (n {connectionId: $connectionId, orgId: $orgId})
            WHERE n:SourceFile OR n:SourceSymbol
            DETACH DELETE n
            RETURN count(n) AS deleted
            `,
            { connectionId, orgId },
          );
          const sourceDeletedCount =
            (sourceDeleteResult.records[0]?.get("deleted") as number | undefined) ?? 0;

          // ── Pass 4: Delete the SourceConnection meta-node ────────────────
          await session.run(
            `
            MATCH (sc:SourceConnection {id: $connectionId, orgId: $orgId})
            DETACH DELETE sc
            `,
            { connectionId, orgId },
          );

          logger.info(
            { connectionId, orgId, deletedCount, sourceDeletedCount },
            "ingestion-delete: neo4j nodes deleted (entities + source files/symbols + meta)",
          );

          return { promoted: promotedCount, deleted: deletedCount + sourceDeletedCount };
        }),
      );
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
