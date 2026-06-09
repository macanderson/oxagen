import { inngest } from "../inngest";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { getConnector } from "@oxagen/ingestion/connectors";
import { renderEntityText, embedEntity } from "@oxagen/ingestion/embed";
import { upsertEntityNode } from "@oxagen/ingestion/mutations";
import type { EntityMutation, SourceRef } from "@oxagen/ingestion/types";
import type { EntityTypeMapping } from "@oxagen/ingestion/pipeline";
import { logger } from "../logger";

/**
 * 6-step ingestion pipeline triggered by `ingestion/entity.received`.
 *
 * Steps are individually retried by Inngest on failure.
 *
 * Step 1: normalize-and-map   connector.normalizeRecord() + entity_type_mappings lookup
 * Step 2: dedup-pass-a        exact naturalKey MATCH in Neo4j
 * Step 3: dedup-pass-b        embedding similarity (stub: always created_principal until
 *                              vector index is queryable from ingestion context)
 * Step 4: upsert-node         MERGE :EntityNode in Neo4j
 * Step 5: embed               embed text, store vector on node
 * Step 6: schedule-inference  fire ingestion/entity.infer asynchronously
 */
export const ingestionPipeline = inngest.createFunction(
  {
    id: "ingestion-pipeline",
    retries: 3,
    concurrency: { limit: 8, key: "event.data.orgId" },
  },
  { event: "ingestion/entity.received" },
  async ({ event, step }) => {
    const { connectionId, workspaceId, orgId, connectorType, sourceRecordType, payload } = event.data;

    // ── Step 1: Normalize raw payload and look up entity type mapping ────────
    const mutation = await step.run("normalize-and-map", async () => {
      const connector = getConnector(connectorType);
      const normalized = connector.normalizeRecord(sourceRecordType, payload);

      // Look up customer's entity type mapping for this (connection, sourceRecordType).
      // Returns null when the customer has not mapped this record type — skip it.
      const mapping = await runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          const rows = await tx.execute(sql`
            SELECT oxagen_entity_type, property_mappings
            FROM   ingestion.entity_type_mappings
            WHERE  connection_id = ${connectionId}::uuid
            AND    source_record_type = ${sourceRecordType}
            LIMIT  1
          `);
          const first = rows[0] as
            | { oxagen_entity_type: string; property_mappings: Record<string, string> | null }
            | undefined;
          return first ?? null;
        }),
      );

      if (!mapping) return null;

      const entityTypeMapping: EntityTypeMapping = {
        oxagenEntityType: mapping.oxagen_entity_type,
        propertyMappings: mapping.property_mappings ?? {},
      };

      // Apply property renames from the customer-configured mapping.
      const mappedProperties: Record<string, unknown> = { ...normalized.properties };
      for (const [sourceField, canonicalName] of Object.entries(entityTypeMapping.propertyMappings)) {
        if (sourceField in mappedProperties) {
          mappedProperties[canonicalName] = mappedProperties[sourceField];
          if (canonicalName !== sourceField) delete mappedProperties[sourceField];
        }
      }

      const sourceRef: SourceRef = {
        connectorType,
        connectionId,
        externalId: normalized.externalId,
        externalUrl: normalized.externalUrl,
      };

      const result: EntityMutation = {
        workspaceId,
        orgId,
        connectionId,
        entityType: entityTypeMapping.oxagenEntityType,
        sourceRecordType,
        naturalKey: `${connectorType}:${connectionId}:${normalized.externalId}`,
        operation: "insert",
        displayName: normalized.displayName,
        properties: mappedProperties,
        sourceRef,
      };

      return result;
    });

    if (!mutation) {
      logger.debug({ connectionId, sourceRecordType }, "ingestion-pipeline: no mapping, skipping");
      return { skipped: true };
    }

    // ── Step 2: Dedup Pass A — exact naturalKey lookup in Neo4j ─────────────
    // Using scopedSession directly here since ingestion graph mutations are
    // tenant-scoped by orgId on the node properties.
    const dedupPassA = await step.run("dedup-pass-a", async (): Promise<{
      found: boolean;
      nodeId?: string;
    }> => {
      // TODO(ingestion): implement Neo4j naturalKey MATCH via scopedSession()
      // MATCH (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId})
      // RETURN n.publicId as nodeId
      // For now: always miss (no Neo4j data yet) so Pass B creates a principal.
      return { found: false };
    });

    // ── Step 3: Dedup Pass B — similarity match (stub until vector query ready) ──
    const dedup = await step.run("dedup-pass-b", async (): Promise<{
      action: "updated_principal" | "created_principal" | "created_alias";
      principalNodeId: string;
      confidence: number;
    }> => {
      if (dedupPassA.found && dedupPassA.nodeId) {
        return {
          action: "updated_principal",
          principalNodeId: dedupPassA.nodeId,
          confidence: 1.0,
        };
      }

      // TODO(ingestion): implement embedding similarity search via Neo4j vector index
      // entity_node_embedding_index — cosine similarity on (n:EntityNode).embedding
      // For now: always create a new principal. The naturalKey uniqueness constraint
      // on Neo4j (entity_node_natural_key index) will deduplicate on upsert.
      const stubNodeId = `pending:${mutation.naturalKey}`;
      return {
        action: "created_principal",
        principalNodeId: stubNodeId,
        confidence: 1.0,
      };
    });

    // ── Step 4: Upsert entity node in Neo4j ──────────────────────────────────
    await step.run("upsert-node", () =>
      upsertEntityNode(mutation, orgId),
    );

    // ── Step 5: Embed ─────────────────────────────────────────────────────────
    const text = renderEntityText(mutation.entityType, mutation.displayName, mutation.properties);
    await step.run("embed", () =>
      embedEntity({
        nodeId: dedup.principalNodeId,
        entityType: mutation.entityType,
        text,
        workspaceId: mutation.workspaceId,
        orgId: mutation.orgId,
        connectionId: mutation.connectionId,
      }),
    );

    // ── Step 6: Fire async inference event ───────────────────────────────────
    await step.sendEvent("schedule-inference", {
      name: "ingestion/entity.infer",
      data: {
        nodeId: dedup.principalNodeId,
        entityType: mutation.entityType,
        propertiesSnapshot: mutation.properties,
        workspaceId: mutation.workspaceId,
        orgId: mutation.orgId,
      },
    });

    logger.info({ naturalKey: mutation.naturalKey, action: dedup.action, orgId }, "ingestion-pipeline: done");
    return { naturalKey: mutation.naturalKey, action: dedup.action };
  },
);
