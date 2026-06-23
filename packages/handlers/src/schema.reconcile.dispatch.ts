import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaReconcileDispatch } from "@oxagen/oxagen/contracts/schema.reconcile.dispatch";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { eventClient } from "./event-client";
import { logger } from "./logger";

export const schemaReconcileDispatchHandler: CapabilityHandler<typeof schemaReconcileDispatch> =
  async (input, ctx) => {
    // Step 1: resolve the schema version row by publicId to get the internal UUID.
    const versionRow = await withTenantDb((tx) =>
      tx.query.schemaVersions.findFirst({
        where: and(
          eq(db.schemaVersions.publicId, input.versionId),
          eq(db.schemaVersions.orgId, ctx.orgId),
          eq(db.schemaVersions.workspaceId, ctx.workspaceId),
        ),
        columns: { id: true, publicId: true, versionNumber: true },
      }),
    );

    if (!versionRow) {
      throw new Error(
        `schema.reconcile.dispatch: schema version not found: ${input.versionId}`,
      );
    }

    // Step 2: insert an agent_executions row tracking this reconciliation job.
    // originType 'schema.reconcile.dispatch' is outside the Drizzle CHECK enum list
    // but the CHECK only exists in the Drizzle schema layer, NOT in the actual
    // migration SQL (§ instructions). The DB accepts any string for origin_type.
    const initialState = {
      totalNodes: 0,
      processedNodes: 0,
      updatedNodes: 0,
      totalRelationships: 0,
      processedRelationships: 0,
      updatedRelationships: 0,
      prune: input.prune,
      prunedNodes: 0,
      prunedRelationships: 0,
      prunedPropertyKeys: {} as Record<string, string[]>,
    };

    const [execRow] = await withTenantDb((tx) =>
      tx
        .insert(db.agentExecutions)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          agentId: null,
          agentVersionId: null,
          originType: "schema.reconcile.dispatch",
          originId: versionRow.id,
          status: "planning",
          inputPayload: { versionId: input.versionId, prune: input.prune },
          outputPayload: null,
          state: initialState,
          startedAt: null,
          completedAt: null,
          createdByUserId: ctx.userId ?? null,
        })
        .returning({
          id: db.agentExecutions.id,
          publicId: db.agentExecutions.publicId,
        }),
    );

    if (!execRow) {
      throw new Error("schema.reconcile.dispatch: agent_executions insert returned no row");
    }

    // Step 3: send the Inngest event to kick off the reconcile worker.
    await eventClient.send({
      name: "schema/reconcile.start",
      data: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        executionId: execRow.id,
        versionId: input.versionId,
        prune: input.prune,
      },
    });

    logger.info(
      {
        executionId: execRow.id,
        executionPublicId: execRow.publicId,
        versionId: input.versionId,
        versionInternalId: versionRow.id,
        prune: input.prune,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      },
      "schema.reconcile.dispatch: dispatched reconciliation job",
    );

    // Step 4: return the public ID (aex_…) so the caller can poll status.
    return { executionId: execRow.publicId };
  };
