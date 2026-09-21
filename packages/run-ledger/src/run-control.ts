import { schema, type Tx } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

/** Shares the run lock used by every append, seal, and attempt admission. */
export async function lockRunForControl(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  publicId: string,
) {
  const [run] = await tx
    .select({
      id: schema.agentRuns.id,
      publicId: schema.agentRuns.publicId,
      status: schema.agentRuns.status,
      cancelled: schema.agentRuns.cancelRequested,
      paused: schema.agentRuns.ingressPaused,
    })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.publicId, publicId),
        eq(schema.agentRuns.orgId, scope.orgId),
        eq(schema.agentRuns.workspaceId, scope.workspaceId),
        eq(schema.agentRuns.specVersion, 2),
      ),
    )
    .for("update");
  return run ?? null;
}

/** The caller writes the command receipt and revokes credentials in this transaction. */
export async function cancelRunInTransaction(tx: Tx, runId: string, now: Date) {
  await tx
    .update(schema.agentRuns)
    .set({ cancelRequested: true, updatedAt: now })
    .where(eq(schema.agentRuns.id, runId));
}

/** Pause affects evidence admission, not the producer's process. */
export async function setRunIngressPaused(
  tx: Tx,
  runId: string,
  paused: boolean,
  now: Date,
) {
  await tx
    .update(schema.agentRuns)
    .set({ ingressPaused: paused, updatedAt: now })
    .where(eq(schema.agentRuns.id, runId));
}
