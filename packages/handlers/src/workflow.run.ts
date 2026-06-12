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

  const outputFormat = input.outputFormat ?? "json";
  const maxParallelism = input.maxParallelism ?? 50;

  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.agentExecutions)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        // agentId/agentVersionId are null for dynamic (LLM-planned) runs.
        originType: "workflow.run",
        originId: ctx.userId!,
        status: "planning",
        inputPayload: {
          title: input.title ?? input.goal.slice(0, 200),
          goal: input.goal,
          outputFormat,
          maxParallelism,
        },
        createdByUserId: ctx.userId!,
        updatedByUserId: ctx.userId!,
      })
      .returning({
        id: schema.agentExecutions.id,
        publicId: schema.agentExecutions.publicId,
      }),
  );

  if (!row) throw new Error("workflow.run: insert returned no row");

  await inngest.send({
    name: "agent/workflow.supervisor.start",
    data: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      executionId: row.id,
      maxParallelism,
      maxTasksGuard: MAX_TASKS_PER_WORKFLOW,
    },
  });

  logger.info(
    { executionId: row.id, publicId: row.publicId, orgId: ctx.orgId },
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
