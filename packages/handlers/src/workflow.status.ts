import type { CapabilityHandler } from "@oxagen/oxagen";
import { workflowStatus } from "@oxagen/oxagen/contracts/workflow.status";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, eq, or } from "drizzle-orm";
import { logger } from "./logger";

export const workflowStatusHandler: CapabilityHandler<
  typeof workflowStatus
> = async (input, ctx) => {
  const execution = await withTenantDb((tx) =>
    tx.query.agentExecutions.findFirst({
      where: and(
        or(
          eq(schema.agentExecutions.id, input.workflowId),
          eq(schema.agentExecutions.publicId, input.workflowId),
        ),
        eq(schema.agentExecutions.orgId, ctx.orgId),
        eq(schema.agentExecutions.workspaceId, ctx.workspaceId),
      ),
    }),
  );

  if (!execution) {
    logger.warn(
      { workflowId: input.workflowId, orgId: ctx.orgId },
      "workflow.status: not found",
    );
    throw new Error(`workflow not found: ${input.workflowId}`);
  }

  const steps = await withTenantDb((tx) =>
    tx
      .select()
      .from(schema.agentExecutionSteps)
      .where(
        and(
          eq(schema.agentExecutionSteps.executionId, execution.id),
          eq(schema.agentExecutionSteps.orgId, ctx.orgId),
        ),
      )
      .orderBy(asc(schema.agentExecutionSteps.stepNumber)),
  );

  const inputPayload = execution.inputPayload as {
    title?: string;
    goal?: string;
    outputFormat?: string;
    maxParallelism?: number;
    plan?: unknown[];
  };

  const toIso = (d: Date | null): string | null => (d ? d.toISOString() : null);

  return {
    workflow: {
      id: execution.id,
      publicId: execution.publicId,
      orgId: execution.orgId,
      workspaceId: execution.workspaceId,
      title: inputPayload.title ?? "",
      goal: inputPayload.goal ?? "",
      status: execution.status as
        | "planning"
        | "running"
        | "completed"
        | "failed"
        | "cancelled",
      planJson: (inputPayload.plan as object[]) ?? [],
      totalTasks: steps.length,
      completedTasks: steps.filter((s) => s.status === "completed").length,
      failedTasks: steps.filter((s) => s.status === "failed").length,
      maxParallelism: inputPayload.maxParallelism ?? 50,
      outputFormat: (inputPayload.outputFormat ?? "json") as "json" | "csv",
      resultUrl: null,
      startedAt: toIso(execution.startedAt),
      completedAt: toIso(execution.completedAt),
      createdAt: execution.createdAt.toISOString(),
      updatedAt: execution.updatedAt.toISOString(),
    },
    tasks: steps.map((s) => {
      const sp = s.inputPayload as { title?: string; goal?: string } | null;
      return {
        id: s.id,
        publicId: s.publicId,
        workflowRunId: execution.id,
        taskIndex: s.stepNumber,
        title: sp?.title ?? "",
        goal: sp?.goal ?? "",
        status: s.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "cancelled",
        inngestRunId: null,
        outputJson: (s.outputPayload as object | null) ?? null,
        error: s.failureReason ?? null,
        startedAt: toIso(s.startedAt),
        completedAt: toIso(s.completedAt),
        createdAt: s.createdAt.toISOString(),
      };
    }),
  };
};
