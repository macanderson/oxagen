 
import { createFunction } from "../create-function";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { getConnector } from "@oxagen/ingestion/connectors";
import { renderEntityText, embedEntity } from "@oxagen/ingestion/embed";
import { upsertEntityNode } from "@oxagen/ingestion/mutations";
import { resolveEntity } from "@oxagen/ingestion/dedup";
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
 * Step 6: schedule-events     fire ingestion/entity.created (trigger matcher) and
 *                              ingestion/entity.infer (semantic inference) asynchronously
 */
export const [ingestionPipeline] = createFunction(
  {
    id: "ingestion-pipeline",
    retries: 3,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "ingestion/entity.received" },
  async ({ event, step, runId }) => {
    const { connectionId, workspaceId, orgId, connectorType, sourceRecordType, payload } = event.data as {
      connectionId: string;
      workspaceId: string;
      orgId: string;
      connectorType: string;
      sourceRecordType: string;
      payload: unknown;
    };

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
    const dedupPassA = await step.run("dedup-pass-a", async (): Promise<{
      found: boolean;
      nodeId?: string;
    }> => {
      return runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          const result = await session.run(
            `MATCH (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId})
             RETURN n.publicId AS nodeId`,
            { naturalKey: mutation.naturalKey, orgId },
          );
          const record = result.records[0];
          if (record) {
            return { found: true, nodeId: record.get("nodeId") as string };
          }
          return { found: false };
        } finally {
          await session.close();
        }
      });
    });

    // ── Step 3: Dedup Pass B — embedding similarity match ───────────────────
    const dedup = await step.run("dedup-pass-b", async (): Promise<{
      action: "updated_principal" | "created_principal" | "created_alias" | "confirmed_alias";
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

      // Pass A missed — run full dedup (embedding similarity + alias creation).
      const resolved = await runInTenantScope({ orgId, workspaceId }, () =>
        resolveEntity(mutation, orgId),
      );

      // A strict-mode rejection means this entity is non-conformant — the
      // pipeline step cannot return a null principalNodeId (the rest of the
      // pipeline would have no node to embed). Throw so Inngest retries or
      // surfaces the failure; the handler upstream logs and filters these.
      if (resolved.action === "rejected_nonconformant" || resolved.principalNodeId === null) {
        throw new Error(
          `ingestion-pipeline: entity rejected as non-conformant (naturalKey=${mutation.naturalKey})`,
        );
      }

      return {
        action: resolved.action,
        principalNodeId: resolved.principalNodeId,
        confidence: resolved.confidence,
      };
    });

    // ── Step 4: Upsert entity node in Neo4j ──────────────────────────────────
    // Each Inngest step.run is memoized and re-executed as its own (potentially
    // separate) invocation, so the tenant scope opened in steps 1–3 does NOT
    // carry into this step — it must open its own. upsertEntityNode →
    // scopedSession() requires an active scope or it throws
    // TenantScopeError(no_tenant_scope), which broke all ingestion in prod
    // (OXA-1790). Steps 2 and 3 already wrap; steps 4 and 5 must too.
    //
    // `runId` (OXA-1932) is threaded through to upsertEntityNode so a retried
    // execution of THIS step re-derives the same schema_conformance_events
    // event_id instead of minting a fresh one — see upsert-entity.ts.
    await step.run("upsert-node", () =>
      runInTenantScope({ orgId, workspaceId }, () => upsertEntityNode(mutation, orgId, { runId })),
    );

    // ── Step 5: Embed ─────────────────────────────────────────────────────────
    // renderEntityText is pure (no DB/Neo4j); only the embedEntity write —
    // embedEntity → upsertEmbedding → scopedSession() — needs the scope.
    const text = renderEntityText(mutation.entityType, mutation.displayName, mutation.properties);
    await step.run("embed", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        embedEntity({
          nodeId: dedup.principalNodeId,
          entityType: mutation.entityType,
          text,
          workspaceId: mutation.workspaceId,
          orgId: mutation.orgId,
          connectionId: mutation.connectionId,
        }),
      ),
    );

    // ── Step 6: Fire async downstream events ─────────────────────────────────
    // Both events are sent in a single step.sendEvent call to keep the step
    // count stable and avoid an extra Inngest checkpoint round-trip.
    //   - ingestion/entity.created  → consumed by playbook.trigger.match
    //   - ingestion/entity.infer    → consumed by semantic edge inference
    await step.sendEvent("schedule-inference", [
      {
        name: "ingestion/entity.created" as never,
        data: {
          nodeId: dedup.principalNodeId,
          entityType: mutation.entityType,
          propertiesSnapshot: mutation.properties,
          workspaceId: mutation.workspaceId,
          orgId: mutation.orgId,
          naturalKey: mutation.naturalKey,
          isNew: dedup.action === "created_principal",
        },
      },
      {
        name: "ingestion/entity.infer" as never,
        data: {
          nodeId: dedup.principalNodeId,
          entityType: mutation.entityType,
          propertiesSnapshot: mutation.properties,
          workspaceId: mutation.workspaceId,
          orgId: mutation.orgId,
        },
      },
    ]);

    logger.info({ naturalKey: mutation.naturalKey, action: dedup.action, orgId }, "ingestion-pipeline: done");
    return { naturalKey: mutation.naturalKey, action: dedup.action };
  },
);
