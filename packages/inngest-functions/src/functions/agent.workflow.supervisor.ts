import { createFunction } from "../create-function";
import { inngest } from "../inngest";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { generateObjectFor } from "@oxagen/ai";
import { runInTenantScope } from "@oxagen/tenancy";
import { NonRetriableError } from "@oxagen/functions";
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

export const [agentWorkflowSupervisor] = createFunction(
  {
    id: "agent.workflow.supervisor",
    retries: 1,
    concurrency: { limit: 5, key: "event.data.orgId" },
    cancelOn: [
      {
        event: "agent/workflow.cancel",
        if: "event.data.executionId == async.data.executionId",
      },
    ],
  },
  { event: "agent/workflow.supervisor.start" },
  async ({ event, step }) => {
    const { orgId, workspaceId, executionId, maxParallelism, maxTasksGuard } =
      event.data as {
        orgId: string;
        workspaceId: string;
        executionId: string;
        maxParallelism: number;
        maxTasksGuard?: number;
      };
    const effectiveMaxTasks = Math.min(
      maxTasksGuard ?? MAX_TASKS_PER_WORKFLOW,
      MAX_TASKS_PER_WORKFLOW,
    );

    const execution = await step.run("load-execution", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx.query.agentExecutions.findFirst({
            where: and(
              eq(schema.agentExecutions.id, executionId),
              eq(schema.agentExecutions.orgId, orgId),
            ),
          }),
        ),
      ),
    );

    if (!execution) {
      logger.error(
        { executionId, orgId },
        "agent.workflow.supervisor: execution not found",
      );
      // Mark the execution row as failed in Postgres so the DB record reflects
      // the terminal state (it would otherwise remain stuck in "planning").
      // Use a best-effort update — ignore any secondary DB error here because
      // the row may not exist, and we are about to throw anyway.
      try {
        await step.run("mark-failed-not-found", () =>
          runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx
                .update(schema.agentExecutions)
                .set({ status: "failed", updatedAt: new Date() })
                .where(
                  and(
                    eq(schema.agentExecutions.id, executionId),
                    eq(schema.agentExecutions.orgId, orgId),
                  ),
                ),
            ),
          ),
        );
      } catch {
        // Swallow secondary DB errors — the NonRetriableError below is the
        // authoritative failure signal to Inngest.
      }
      // Throw so Inngest marks the run as failed and does NOT retry (a missing
      // row will not self-heal on retry).
      throw new NonRetriableError(
        `agent.workflow.supervisor: execution not found (executionId=${executionId})`,
        { cause: { executionId, orgId } },
      );
    }

    const { goal, outputFormat } = execution.inputPayload as {
      goal: string;
      outputFormat: "json" | "csv";
    };

    // ── Step 1: Plan ────────────────────────────────────────────────────────
    const { object: plan } = await step.run("plan", () =>
      generateObjectFor({
        schema: taskPlanSchema,
        system: `You are a workflow planner. Given a high-level goal, decompose it into discrete, independently executable sub-tasks.
Each task should be specific and achievable by a single web search + data extraction agent.
Return between 2 and ${effectiveMaxTasks} tasks. Number them starting from 0.`,
        prompt: `Goal: ${goal}\n\nDecompose this into specific, parallel research sub-tasks. Each task should have a clear, searchable goal.`,
        telemetry: {
          orgId,
          workspaceId,
          surface: "runner" as const,
          messageId: executionId,
        },
      }),
    );

    const tasks = plan.tasks.slice(0, effectiveMaxTasks);

    // ── Step 2: Persist plan ────────────────────────────────────────────────
    await step.run("persist-plan", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          await tx
            .update(schema.agentExecutions)
            .set({
              status: "running",
              inputPayload: { goal, outputFormat, plan: tasks },
              startedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.agentExecutions.id, executionId));

          await tx.insert(schema.agentExecutionSteps).values(
            tasks.map((t) => ({
              executionId,
              orgId,
              workspaceId,
              stepNumber: t.taskIndex,
              stepType: "research",
              status: "pending",
              inputPayload: { title: t.title, goal: t.goal, outputFormat },
              createdByUserId: null,
              updatedByUserId: null,
            })),
          );
        }),
      ),
    );

    // Load inserted step IDs for dispatching.
    const stepRows = await step.run("load-step-ids", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .select({
              id: schema.agentExecutionSteps.id,
              stepNumber: schema.agentExecutionSteps.stepNumber,
              inputPayload: schema.agentExecutionSteps.inputPayload,
            })
            .from(schema.agentExecutionSteps)
            .where(
              and(
                eq(schema.agentExecutionSteps.executionId, executionId),
                eq(schema.agentExecutionSteps.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    // ── Step 3: Dispatch in batches respecting maxParallelism ───────────────
    const batchSize = Math.min(maxParallelism, 100);
    for (let i = 0; i < stepRows.length; i += batchSize) {
      const batch = stepRows.slice(i, i + batchSize);
      const batchLabel = `dispatch-batch-${Math.floor(i / batchSize)}`;
      await step.run(batchLabel, () =>
        inngest.send(
          batch.map(
            (s: { id: string; stepNumber: number; inputPayload: unknown }) => {
              const payload = s.inputPayload as {
                goal: string;
                outputFormat: "json" | "csv";
              };
              return {
                name: "agent/workflow.task.execute" as const,
                data: {
                  orgId,
                  workspaceId,
                  executionId,
                  stepId: s.id,
                  taskIndex: s.stepNumber,
                  goal: payload.goal,
                  outputFormat: payload.outputFormat,
                },
              };
            },
          ),
        ),
      );
    }

    logger.info(
      { executionId, orgId, tasksDispatched: tasks.length },
      "agent.workflow.supervisor: dispatched all tasks",
    );

    return { executionId, tasksDispatched: tasks.length };
  },
);
