import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaReconcileStatus } from "@oxagen/oxagen/contracts/schema.reconcile.status";
import { schema as db, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

interface ReconcileState {
  totalNodes?: number;
  processedNodes?: number;
  updatedNodes?: number;
  totalRelationships?: number;
  processedRelationships?: number;
  updatedRelationships?: number;
  prunedNodes?: number;
  prunedRelationships?: number;
}

export const schemaReconcileStatusHandler: CapabilityHandler<
  typeof schemaReconcileStatus
> = async (input, ctx) => {
  // Look up the agent_executions row by publicId within this tenant.
  const execRow = await withTenantDb((tx) =>
    tx.query.agentExecutions.findFirst({
      where: and(
        eq(db.agentExecutions.publicId, input.executionId),
        eq(db.agentExecutions.orgId, ctx.orgId),
        eq(db.agentExecutions.workspaceId, ctx.workspaceId),
      ),
      columns: {
        status: true,
        state: true,
      },
    }),
  );

  if (!execRow) {
    throw new Error(
      `schema.reconcile.status: execution not found: ${input.executionId}`,
    );
  }

  // Parse the state JSONB field and project the counter fields.
  const state = (execRow.state ?? {}) as ReconcileState;

  return {
    status: execRow.status as
      | "planning"
      | "running"
      | "completed"
      | "failed"
      | "cancelled",
    totalNodes: state.totalNodes ?? 0,
    processedNodes: state.processedNodes ?? 0,
    updatedNodes: state.updatedNodes ?? 0,
    totalRelationships: state.totalRelationships ?? 0,
    processedRelationships: state.processedRelationships ?? 0,
    updatedRelationships: state.updatedRelationships ?? 0,
    prunedNodes: state.prunedNodes ?? 0,
    prunedRelationships: state.prunedRelationships ?? 0,
  };
};
