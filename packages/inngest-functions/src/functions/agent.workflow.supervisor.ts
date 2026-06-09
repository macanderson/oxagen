import { inngest } from "../inngest";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { generateObjectFor } from "@oxagen/ai";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";
import { z } from "zod";

const MAX_TASKS_PER_WORKFLOW = 500;

const taskPlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        taskIndex: z.number().int().min(0),
        title: z.string().min(1).max(200),
        goal: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(MAX_TASKS_PER_WORKFLOW),
});

export const agentWorkflowSupervisor = inngest.createFunction(
  {
    id: "agent.workflow.supervisor",
    retries: 1,
    concurrency: { limit: 10, key: "event.data.orgId" },
    cancelOn: [
      {
        event: "agent/workflow.cancel",
        if: "event.data.workflowRunId == async.data.workflowRunId",
      },
    ],
  },
  { event: "agent/workflow.supervisor.start" },
  async ({ event, step }) => {
    const { orgId, workspaceId, workflowRunId, maxParallelism, maxTasksGuard } = event.data as {
      orgId: string;
      workspaceId: string;
      workflowRunId: string;
      maxParallelism: number;
      maxTasksGuard?: number;
    };
    const effectiveMaxTasks = Math.min(maxTasksGuard ?? MAX_TASKS_PER_WORKFLOW, MAX_TASKS_PER_WORKFLOW);

    const run = await step.run("load-run", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx.query.workflowRuns.findFirst({
            where: and(
              eq(schema.workflowRuns.id, workflowRunId),
              eq(schema.workflowRuns.orgId, orgId),
            ),
          }),
        ),
      ),
    );

    if (!run) {
      logger.error({ workflowRunId, orgId }, "agent.workflow.supervisor: run not found");
      return { status: "failed", reason: "run not found" };
    }

    // ── Step 1: Plan ────────────────────────────────────────────────────────
    const { object: plan } = await step.run("plan", () =>
      generateObjectFor({
        schema: taskPlanSchema,
        system: `You are a workflow planner. Given a high-level goal, decompose it into discrete, independently executable sub-tasks.
Each task should be specific and achievable by a single web search + data extraction agent.
Return between 2 and ${effectiveMaxTasks} tasks. Number them starting from 0.`,
        prompt: `Goal: ${run.goal}\n\nDecompose this into specific, parallel research sub-tasks. Each task should have a clear, searchable goal.`,
        telemetry: {
          orgId,
          workspaceId,
          surface: "runner" as const,
          messageId: workflowRunId,
        },
      }),
    );

    const tasks = plan.tasks.slice(0, effectiveMaxTasks);

    // ── Step 2: Persist plan ────────────────────────────────────────────────
    await step.run("persist-plan", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          await tx
            .update(schema.workflowRuns)
            .set({
              status: "running",
              planJson: tasks,
              totalTasks: tasks.length,
              startedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.workflowRuns.id, workflowRunId));

          await tx.insert(schema.workflowRunTasks).values(
            tasks.map((t) => ({
              orgId,
              workspaceId,
              workflowRunId,
              taskIndex: t.taskIndex,
              title: t.title,
              goal: t.goal,
              status: "pending" as const,
              createdByUserId: null,
              updatedByUserId: null,
            })),
          );
        }),
      ),
    );

    // Load inserted task IDs for dispatching.
    const taskRows = await step.run("load-task-ids", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .select({
              id: schema.workflowRunTasks.id,
              taskIndex: schema.workflowRunTasks.taskIndex,
              goal: schema.workflowRunTasks.goal,
            })
            .from(schema.workflowRunTasks)
            .where(
              and(
                eq(schema.workflowRunTasks.workflowRunId, workflowRunId),
                eq(schema.workflowRunTasks.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    // ── Step 3: Dispatch in batches respecting maxParallelism ───────────────
    const batchSize = Math.min(maxParallelism, 100);
    for (let i = 0; i < taskRows.length; i += batchSize) {
      const batch = taskRows.slice(i, i + batchSize);
      const batchLabel = `dispatch-batch-${Math.floor(i / batchSize)}`;
      await step.run(batchLabel, () =>
        inngest.send(
          batch.map((t: { id: string; taskIndex: number; goal: string }) => ({
            name: "agent/workflow.task.execute" as const,
            data: {
              orgId,
              workspaceId,
              workflowRunId,
              taskId: t.id,
              taskIndex: t.taskIndex,
              goal: t.goal,
              outputFormat: run.outputFormat as "json" | "csv",
            },
          })),
        ),
      );
    }

    logger.info(
      { workflowRunId, orgId, tasksDispatched: tasks.length },
      "agent.workflow.supervisor: dispatched all tasks",
    );

    return { workflowRunId, tasksDispatched: tasks.length };
  },
);
