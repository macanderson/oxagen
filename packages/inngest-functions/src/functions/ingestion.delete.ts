import { createFunction } from "../create-function";
import { countOf } from "../lib/driver-count";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology";
import { insertEvents } from "@oxagen/telemetry";
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
 * Step 2: delete-neo4j-data    alias promotion, then remove the connection's nodes
 * Step 3: delete-postgres      wipe mappings, credentials, webhook subs; mark deleted
 * Step 4: audit-log            write deletion event to ClickHouse
 * Step 5: finalize-deletion-job  mark the deletion_jobs row completed (progress + completed_at)
 *
 * The `deletion_jobs` row is created by connection.delete with status='running'.
 * This function OWNS the terminal transition: the primary handler marks it
 * 'completed' on success (Step 5); the on-failure companion marks it 'failed'
 * (with completed_at + error) once retries are exhausted.
 */
export const [ingestionDeleteConnection, ingestionDeleteConnectionOnFailure] =
  createFunction(
    {
      id: "ingestion-delete-connection",
      retries: 2,
      concurrency: { limit: 2, key: "event.data.orgId" },
      // Terminal-failure handler: fires on `inngest/function.failed` after all
      // retries are exhausted. Marks the deletion_jobs row 'failed' so the UI
      // stops showing an eternally-'running' job. Mirrors privacy.erasure.execute.
      onFailure: async ({ event, step }) => {
        const failureData = event.data as {
          event?: {
            data?: {
              deletionJobId?: string;
              orgId?: string;
              workspaceId?: string;
            };
          };
          error?: unknown;
        };
        const deletionJobId = failureData.event?.data?.deletionJobId;
        const orgId = failureData.event?.data?.orgId;
        const workspaceId = failureData.event?.data?.workspaceId;
        if (!deletionJobId || !orgId || !workspaceId) return;

        const errorMessage =
          typeof failureData.error === "object" &&
          failureData.error !== null &&
          "message" in failureData.error
            ? String((failureData.error as { message: unknown }).message)
            : String(failureData.error ?? "unknown error");

        await step.run("mark-deletion-job-failed", () =>
          runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx.execute(sql`
              UPDATE ingestion.deletion_jobs
              SET    status       = 'failed',
                     completed_at = NOW(),
                     error        = ${errorMessage}
              WHERE  id     = ${deletionJobId}::uuid
              AND    org_id = ${orgId}::uuid
            `),
            ),
          ),
        );

        logger.error(
          { deletionJobId, orgId, error: errorMessage },
          "ingestion-delete-connection: marked deletion job failed",
        );
      },
    },
    { event: "ingestion/connection.delete" },
    async ({ event, step }) => {
      const {
        connectionId,
        deletionJobId,
        orgId,
        workspaceId,
        mode,
        requestedBy,
        requestedAt,
      } = event.data as {
        connectionId: string;
        deletionJobId?: string;
        orgId: string;
        workspaceId: string;
        mode: string;
        requestedBy: string;
        requestedAt: string;
      };

      // Rolls up graph-deletion progress for the deletion_jobs finalizer (Step 5).
      let deletedEntities = 0;
      let aliasPromotions = 0;

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
        const neo4jResult = await step.run("delete-neo4j-data", () =>
          runInTenantScope({ orgId, workspaceId }, async () => {
            const session = scopedSession();

            // ── Pass 1: Promote aliases ──────────────────────────────────────
            // Find principal nodes (from this connection) that have incoming
            // ALIAS_OF edges from OTHER connections. Promote the highest-
            // confidence alias to become the new principal before deletion.
            //
            // WHAT THE WORKSPACE ANCHORS BELOW COST, stated rather than left to
            // be discovered. The dedup resolver's candidate search
            // (packages/ingestion/src/dedup/resolve.ts, `WHERE n.orgId =
            // $orgId AND n.entityType = $entityType`) is org-scoped and not
            // workspace-scoped, so an ALIAS_OF edge CAN today join two
            // workspaces of one org. Such an alias is no longer promoted here.
            // That is the deliberate direction: refusing to promote leaves a
            // node in a workspace this job has no business writing to exactly
            // as it found it, whereas promoting it overwrites that node's
            // naturalKey, displayName and properties with another workspace's.
            // A retained node is visible and recoverable; an overwritten one is
            // neither. The cross-workspace edge itself is still removed, by the
            // DETACH DELETE in Pass 2/3 -- an edge cannot outlive the node it
            // is attached to -- and the foreign node survives untouched.
            //
            // Passes 2-4 deliberately stay keyed on {connectionId, orgId} and
            // are NOT narrowed by workspace. They DELETE rather than write, and
            // a connection belongs to exactly one workspace, so the workspace
            // predicate would be a no-op on correctly stamped data and, on
            // mis-stamped data, would silently RETAIN a deleted connection's
            // nodes. For a delete, over-scoping is the harmful direction.
            const aliasResult = await session.run(
              `
            MATCH (alias:EntityNode)-[r:ALIAS_OF]->(principal:EntityNode)
            WHERE principal.connectionId = $connectionId
              AND principal.orgId = $orgId
              // The principal is the anchor every other row here is selected
              // through, so it carries the full tenant, not half of it. An org
              // check passes for every workspace in that org, and an id alone
              // says WHICH node, never WHOSE.
              AND principal.workspaceId = $workspaceId
              // The alias is PROMOTED below -- its identity fields are
              // overwritten -- so it has to be at least as scoped as the
              // principal it is replacing. Anchoring one endpoint of a
              // two-endpoint match leaves the other free, and a legacy or BYO
              // graph can hold an ALIAS_OF from another organisation's node.
              //
              // BOTH halves are load-bearing and neither implies the other: a
              // workspace id is not unique across organisations, so the org
              // predicate is the only thing refusing a same-workspace-id row
              // from another org; and the org predicate passes for every
              // workspace inside it, so the workspace predicate is the only
              // thing refusing a sibling workspace. This is the boundary the
              // read surface already enforces -- graph.node.list, graph.stats,
              // graph.search, ontology.neighbors, ontology.query and
              // reference.search all filter :GraphNode on orgId AND
              // workspaceId -- so a node another workspace cannot even READ
              // must not be one this job silently OVERWRITES.
              AND alias.orgId = $orgId
              AND alias.workspaceId = $workspaceId
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
              // Same reason: this branch MERGEs a new edge off other and
              // DELETEs its existing one, so other is written to and must
              // carry the same tenant as the principal being dissolved -- the
              // WHOLE tenant, for the reasons given on the alias anchor above.
              AND other.orgId = $orgId
              AND other.workspaceId = $workspaceId
            MERGE (other)-[newEdge:ALIAS_OF]->(promoted)
              // Rerouting an existing edge, so every property is COPIED rather
              // than re-stamped: a reroute is not a new observation, and a
              // fresh validFrom would rewrite the dedup ledger's history.
              //
              // Copied WHOLESALE, as a map, rather than key by key. An
              // enumeration is only complete on the day it is written: this one
              // listed nine properties and was described as complete, and it
              // already omitted updatedAt, which createAliasEdge's ON MATCH
              // branch stamps every time an alias is re-asserted -- so promoting
              // an alias dropped the timestamp belonging to the confidence
              // value it kept. properties(old) inverts the default: every
              // property survives unless something below deliberately overrides
              // it, which is the only shape that stays correct when a tenth
              // property appears. Today that is the bi-temporal set, the dedup
              // fields, and anything a historical schema-reconcile pass wrote
              // through its SET r += props write-back before ALIAS_OF was
              // excluded from reconciliation by type.
              //
              // is_system is the one override, and it is a LEGACY DEFAULT, not
              // a re-stamp: it is the marker that keeps schema reconciliation's
              // prune off platform-owned edges, and an edge written before any
              // writer set it has it absent rather than false. Copying the map
              // would carry that absence forward; coalescing repairs it.
              ON CREATE SET newEdge = properties(old),
                            newEdge.is_system = coalesce(old.is_system, true)
            // A MERGE that MATCHED means other was already a direct alias
            // of promoted. That edge is an assertion between the two surviving
            // nodes and outranks a rerouted one, so it keeps its own properties
            // and old is dropped -- deliberate, and stated because it is the
            // one path where a property does not survive the reroute.
            DELETE old
            RETURN count(promoted) AS promoted
            `,
              // orgId/workspaceId are injected (and overwritten) by the scoped
              // session seam; passed here so the anchor and its value read
              // together at the call site rather than only in tenant.ts.
              { connectionId, orgId, workspaceId },
            );

            const promotedCount = countOf(
              aliasResult.records[0]?.get("promoted"),
            );
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

            const deletedCount = countOf(
              deleteResult.records[0]?.get("deleted"),
            );

            // ── Pass 3: Delete every other node this connection produced ─────
            // Catch-all for all NON-EntityNode artifacts stamped with this
            // connectionId — SourceFile, SourceSymbol, Feature, and any future
            // connector-derived label. EntityNode is handled in Pass 2 (it carries
            // ALIAS_OF promotion semantics); everything else is removed
            // unconditionally, so no connector-derived node type can leak as an
            // orphan after a delete. DETACH DELETE also drops CONTAINS /
            // SOURCED_FROM and any other edges.
            const sourceDeleteResult = await session.run(
              `
            MATCH (n {connectionId: $connectionId, orgId: $orgId})
            WHERE NOT n:EntityNode
            DETACH DELETE n
            RETURN count(n) AS deleted
            `,
              { connectionId, orgId },
            );
            const sourceDeletedCount = countOf(
              sourceDeleteResult.records[0]?.get("deleted"),
            );

            // ── Pass 4: Delete the SourceConnection meta-node ────────────────
            await session.run(
              `
            MATCH (sc:SourceConnection {id: $connectionId, orgId: $orgId})
            DETACH DELETE sc
            `,
              { connectionId, orgId },
            );

            logger.info(
              {
                connectionId,
                orgId,
                deletedCount,
                sourceDeletedCount,
              },
              "ingestion-delete: neo4j nodes deleted (entities + connection-stamped + meta)",
            );

            // Both already plain numbers via countOf, so this sum is a number
            // and the object survives the JSON round-trip Inngest does to
            // memoize a step's output. Summing the driver's Integers directly
            // would produce a BigInt, which JSON cannot represent.
            return {
              promoted: promotedCount,
              deleted: deletedCount + sourceDeletedCount,
            };
          }),
        );

        // Read the memoized step output through countOf rather than asserting
        // its shape with `as`. A replayed step hands back whatever survived
        // JSON, which is not always what the callback returned, and the cast
        // that used to sit here said `number` for a value that reached this
        // line as `undefined`.
        const graphProgress = neo4jResult as
          | { promoted?: unknown; deleted?: unknown }
          | null
          | undefined;
        aliasPromotions = countOf(graphProgress?.promoted);
        deletedEntities = countOf(graphProgress?.deleted);
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
              // The column is deleted_by_id — connection.list filters on
              // deleted_at IS NULL, so this UPDATE is what retires the row.
              await tx.execute(sql`
              UPDATE ingestion.source_connections
              SET    status             = 'deleted',
                     deleted_at         = NOW(),
                     deleted_by_id = ${requestedBy}::uuid,
                     updated_at         = NOW()
              WHERE  id     = ${connectionId}::uuid
              AND    org_id = ${orgId}::uuid
            `);
            }),
          ),
        );
      }

      // ── Step 4: Audit log ────────────────────────────────────────────────────
      await step.run("audit-log", async () => {
        // Local Pino trace — always emitted so the deletion is visible in logs.
        logger.info(
          { connectionId, orgId, workspaceId, mode, requestedBy, requestedAt },
          "ingestion-delete-connection: completed",
        );

        // Append-only runtime event to ClickHouse (four-store model: ClickHouse
        // holds runtime events only). Emitted through @oxagen/telemetry's generic
        // `events` table — no bespoke ingestion schema needed; source_system tags
        // the emitter and the payload carries the deletion detail.
        //
        // Fire-and-forget-safe: the connection is already deleted by this point,
        // so a ClickHouse write failure must NEVER fail (and thus retry) the
        // deletion job. Any error is logged and swallowed, not thrown.
        try {
          await insertEvents([
            {
              event_id: globalThis.crypto.randomUUID(),
              org_id: orgId,
              workspace_id: workspaceId,
              event_type: "ingestion.connection.deleted",
              source_system: "inngest:ingestion.delete-connection",
              stream_offset: null,
              payload: JSON.stringify({
                connectionId,
                mode,
                requestedBy,
                requestedAt,
              }),
              emitted_at: new Date().toISOString(),
            },
          ]);
        } catch (err) {
          logger.error(
            { err, connectionId, orgId, workspaceId, mode, requestedBy },
            "ingestion-delete-connection: ClickHouse audit event write failed — deletion already applied, telemetry event dropped",
          );
        }
      });

      // ── Step 5: Finalize the deletion_jobs row ───────────────────────────────
      // Mark the tracking row created by connection.delete as terminally
      // 'completed' with completed_at and the observed graph-deletion progress.
      // Guarded on deletionJobId so an event with no id set still completes
      // without throwing.
      //
      // Both counters are re-narrowed through countOf immediately before the
      // template, belt and braces over the countOf calls at the assignment.
      // drizzle's `sql` tag emits an EMPTY CHUNK for an `undefined`
      // interpolation — no placeholder, no parameter, nothing — so a single
      // undefined turns `SET deleted_entities = ${x}, alias_promotions = ${y}`
      // into the literal text `SET deleted_entities = , alias_promotions = $1`,
      // which Postgres rejects with a syntax error before it can run. That is
      // not a hypothetical: it is what production did every ~65s while five
      // deletion_jobs rows sat in 'running', the oldest for a week, because the
      // step failed, Inngest retried, and the retry failed the same way. An
      // undefined must never reach this template again.
      if (deletionJobId) {
        const finalDeletedEntities = countOf(deletedEntities);
        const finalAliasPromotions = countOf(aliasPromotions);
        await step.run("finalize-deletion-job", () =>
          runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx.execute(sql`
              UPDATE ingestion.deletion_jobs
              SET    status           = 'completed',
                     completed_at     = NOW(),
                     deleted_entities = ${finalDeletedEntities},
                     alias_promotions = ${finalAliasPromotions}
              WHERE  id     = ${deletionJobId}::uuid
              AND    org_id = ${orgId}::uuid
            `),
            ),
          ),
        );
      }

      return { connectionId, mode, deletedAt: new Date().toISOString() };
    },
  );
