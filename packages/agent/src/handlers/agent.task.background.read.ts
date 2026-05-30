import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types.js";

export interface AgentTaskBackgroundReadInput {
  taskId: string;
}

export interface AgentTaskBackgroundReadOutput {
  taskId: string;
  kind: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  label: string | null;
  resultPayload: unknown;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export async function agentTaskBackgroundReadHandler(
  input: AgentTaskBackgroundReadInput,
  ctx: CapabilityContext,
): Promise<AgentTaskBackgroundReadOutput> {
  const [row] = await db()
    .select()
    .from(schema.backgroundTasks)
    .where(
      and(
        eq(schema.backgroundTasks.publicId, input.taskId),
        eq(schema.backgroundTasks.orgId, ctx.orgId),
        eq(schema.backgroundTasks.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`Background task ${input.taskId} not found`);
  return {
    taskId: row.publicId,
    kind: row.kind,
    status: row.status as AgentTaskBackgroundReadOutput["status"],
    label: row.label,
    resultPayload: row.resultPayload,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
