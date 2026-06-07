import { inngest } from "../inngest";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import { generateObjectFor } from "@oxagen/ai";
import { runInTenantScope } from "@oxagen/tenancy";
import { insertToolInvocation } from "@oxagen/telemetry";
import { logger } from "../logger";
import { z } from "zod";

const taskOutputSchema = z.object({
  summary: z.string(),
  data: z.unknown(),
  sources: z.array(z.string()).optional(),
});

export const agentWorkflowTaskExecute = inngest.createFunction(
  {
    id: "agent.workflow.task.execute",
    retries: 1,
    concurrency: { limit: 100, key: "event.data.orgId" },
    cancelOn: [
      {
        event: "agent/workflow.cancel",
        if: "event.data.workflowRunId == async.data.workflowRunId",
      },
    ],
  },
  { event: "agent/workflow.task.execute" },
  async ({ event, step }) => {
    const { orgId, workspaceId, workflowRunId, taskId, taskIndex, goal, outputFormat } =
      event.data;

    const invocationId = crypto.randomUUID();
    const startedAt = Date.now();

    // Mark task running.
    await step.run("mark-running", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.workflowRunTasks)
            .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(schema.workflowRunTasks.id, taskId),
                eq(schema.workflowRunTasks.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    let output: z.output<typeof taskOutputSchema>;
    try {
      const result = await step.run("execute", () =>
        generateObjectFor({
          schema: taskOutputSchema,
          system: `You are a research agent. Given a specific research goal, produce a concise structured result.
Provide a summary, any relevant structured data, and source references if applicable.`,
          prompt: `Research goal: ${goal}\n\nProvide your findings as structured output. Output format: ${outputFormat}.`,
          telemetry: {
            orgId,
            workspaceId,
            surface: "runner" as const,
            messageId: taskId,
          },
        }),
      );
      output = result.object;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ taskId, workflowRunId, orgId, err }, "agent.workflow.task.execute: failed");

      await step.run("mark-failed", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.workflowRunTasks)
              .set({
                status: "failed",
                error: errMsg,
                completedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.workflowRunTasks.id, taskId),
                  eq(schema.workflowRunTasks.orgId, orgId),
                ),
              ),
          ),
        ),
      );

      // Increment failed_tasks counter on parent run.
      await step.run("increment-failed", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.workflowRuns)
              .set({
                failedTasks: sql`${schema.workflowRuns.failedTasks} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(schema.workflowRuns.id, workflowRunId)),
          ),
        ),
      );

      try {
        await insertToolInvocation({
          invocation_id: invocationId,
          org_id: orgId,
          workspace_id: workspaceId,
          capability_name: "workflow.task.execute",
          message_id: taskId,
          parent_message_id: workflowRunId,
          execution_step_id: null,
          status: "failed",
          input_size_bytes: 0,
          output_size_bytes: 0,
          latency_ms: Date.now() - startedAt,
          error_class: err instanceof Error ? err.name : "UnknownError",
          external_provider: "",
          external_server_id: null,
          risk_level: "low",
          required_approval: 0,
          surface: "runner",
          provider: "",
          created_at: new Date().toISOString(),
        });
      } catch {
        /* swallow */
      }

      throw err;
    }

    // Mark completed.
    await step.run("mark-completed", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.workflowRunTasks)
            .set({
              status: "completed",
              outputJson: output as object,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.workflowRunTasks.id, taskId),
                eq(schema.workflowRunTasks.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    // Increment completed_tasks counter and check if all tasks are done.
    const updatedRun = await step.run("increment-completed", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          const [updated] = await tx
            .update(schema.workflowRuns)
            .set({
              completedTasks: sql`${schema.workflowRuns.completedTasks} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(schema.workflowRuns.id, workflowRunId))
            .returning({
              completedTasks: schema.workflowRuns.completedTasks,
              failedTasks: schema.workflowRuns.failedTasks,
              totalTasks: schema.workflowRuns.totalTasks,
              status: schema.workflowRuns.status,
            });
          return updated;
        }),
      ),
    );

    // If all tasks are done, mark the workflow completed.
    if (
      updatedRun &&
      updatedRun.status === "running" &&
      updatedRun.completedTasks + updatedRun.failedTasks >= updatedRun.totalTasks
    ) {
      const finalStatus =
        updatedRun.completedTasks > 0 ? "completed" : "failed";
      await step.run("finalize-workflow", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.workflowRuns)
              .set({
                status: finalStatus,
                completedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.workflowRuns.id, workflowRunId)),
          ),
        ),
      );
    }

    try {
      await insertToolInvocation({
        invocation_id: invocationId,
        org_id: orgId,
        workspace_id: workspaceId,
        capability_name: "workflow.task.execute",
        message_id: taskId,
        parent_message_id: workflowRunId,
        execution_step_id: null,
        status: "completed",
        input_size_bytes: 0,
        output_size_bytes: 0,
        latency_ms: Date.now() - startedAt,
        error_class: null,
        external_provider: "",
        external_server_id: null,
        risk_level: "low",
        required_approval: 0,
        surface: "runner",
        provider: "",
        created_at: new Date().toISOString(),
      });
    } catch {
      /* swallow */
    }

    logger.info({ taskId, taskIndex, workflowRunId, orgId }, "agent.workflow.task.execute: completed");
    return { taskId, taskIndex, status: "completed" };
  },
);
