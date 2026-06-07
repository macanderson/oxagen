import type { CapabilityHandler } from "@oxagen/oxagen";
import { workflowStatus } from "@oxagen/oxagen/contracts/workflow.status";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, eq, or } from "drizzle-orm";
import { logger } from "./logger";

export const workflowStatusHandler: CapabilityHandler<typeof workflowStatus> = async (
  input,
  ctx,
) => {
  const run = await withTenantDb((tx) =>
    tx.query.workflowRuns.findFirst({
      where: and(
        or(
          eq(schema.workflowRuns.id, input.workflowId),
          eq(schema.workflowRuns.publicId, input.workflowId),
        ),
        eq(schema.workflowRuns.orgId, ctx.orgId),
        eq(schema.workflowRuns.workspaceId, ctx.workspaceId),
      ),
    }),
  );

  if (!run) {
    logger.warn({ workflowId: input.workflowId, orgId: ctx.orgId }, "workflow.status: not found");
    throw new Error(`workflow not found: ${input.workflowId}`);
  }

  const tasks = await withTenantDb((tx) =>
    tx
      .select()
      .from(schema.workflowRunTasks)
      .where(
        and(
          eq(schema.workflowRunTasks.workflowRunId, run.id),
          eq(schema.workflowRunTasks.orgId, ctx.orgId),
        ),
      )
      .orderBy(asc(schema.workflowRunTasks.taskIndex)),
  );

  const toIso = (d: Date | null): string | null => (d ? d.toISOString() : null);

  return {
    workflow: {
      id: run.id,
      publicId: run.publicId,
      orgId: run.orgId,
      workspaceId: run.workspaceId,
      title: run.title,
      goal: run.goal,
      status: run.status as "planning" | "running" | "completed" | "failed" | "cancelled",
      planJson: run.planJson,
      totalTasks: run.totalTasks,
      completedTasks: run.completedTasks,
      failedTasks: run.failedTasks,
      maxParallelism: run.maxParallelism,
      outputFormat: run.outputFormat as "json" | "csv",
      resultUrl: run.resultUrl ?? null,
      startedAt: toIso(run.startedAt),
      completedAt: toIso(run.completedAt),
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      publicId: t.publicId,
      workflowRunId: t.workflowRunId,
      taskIndex: t.taskIndex,
      title: t.title,
      goal: t.goal,
      status: t.status as "pending" | "running" | "completed" | "failed" | "cancelled",
      inngestRunId: t.inngestRunId ?? null,
      outputJson: t.outputJson ?? null,
      error: t.error ?? null,
      startedAt: toIso(t.startedAt),
      completedAt: toIso(t.completedAt),
      createdAt: t.createdAt.toISOString(),
    })),
  };
};
