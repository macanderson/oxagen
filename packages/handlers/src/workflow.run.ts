import type { CapabilityHandler } from "@oxagen/oxagen";
import { workflowRun } from "@oxagen/oxagen/contracts/workflow.run";
import { schema, withTenantDb } from "@oxagen/database";
import { inngest } from "@oxagen/inngest-functions/client";
import { logger } from "./logger";

const MAX_TASKS_PER_WORKFLOW = 500;

export const workflowRunHandler: CapabilityHandler<typeof workflowRun> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "workflow.run: rejected — no authenticated user");
    throw new Error("workflow.run requires an authenticated user");
  }

  const title = input.title ?? input.goal.slice(0, 200);
  const outputFormat = input.outputFormat ?? "json";
  const maxParallelism = input.maxParallelism ?? 50;

  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.workflowRuns)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        title,
        goal: input.goal,
        status: "planning",
        outputFormat,
        maxParallelism,
        createdByUserId: ctx.userId!,
        updatedByUserId: ctx.userId!,
      })
      .returning({
        id: schema.workflowRuns.id,
        publicId: schema.workflowRuns.publicId,
      }),
  );

  if (!row) throw new Error("workflow.run: insert returned no row");

  await inngest.send({
    name: "agent/workflow.supervisor.start",
    data: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      workflowRunId: row.id,
      maxParallelism,
      maxTasksGuard: MAX_TASKS_PER_WORKFLOW,
    },
  });

  logger.info(
    { workflowRunId: row.id, publicId: row.publicId, orgId: ctx.orgId },
    "workflow.run: dispatched supervisor",
  );

  return {
    workflowId: row.id,
    publicId: row.publicId,
    status: "planning" as const,
    render: {
      componentId: "workflow-progress" as const,
      props: { workflowId: row.id },
    },
  };
};
