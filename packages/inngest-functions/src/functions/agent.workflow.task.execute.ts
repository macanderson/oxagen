import { createFunction } from "../create-function";
import { schema, withTenantDb } from "@oxagen/database";
import { and, count, eq, sql } from "drizzle-orm";
import { generateObjectFor } from "@oxagen/ai";
import { runInTenantScope } from "@oxagen/tenancy";
import { insertToolInvocation, deterministicEventId } from "@oxagen/telemetry";
import {
  claimExecutionStep,
  renewExecutionStepLease,
  startLeaseRenewal,
} from "../lease";
import { logger } from "../logger";
import { z } from "zod";

const taskOutputSchema = z.object({
  summary: z.string(),
  data: z.unknown(),
  sources: z.array(z.string()).optional(),
});

export const [agentWorkflowTaskExecute] = createFunction(
  {
    id: "agent.workflow.task.execute",
    retries: 1,
    concurrency: { limit: 5, key: "event.data.orgId" },
    cancelOn: [
      {
        event: "agent/workflow.cancel",
        if: "event.data.executionId == async.data.executionId",
      },
    ],
  },
  { event: "agent/workflow.task.execute" },
  async ({ event, step, runId }) => {
    const {
      orgId,
      workspaceId,
      executionId,
      stepId,
      taskIndex,
      goal,
      outputFormat,
    } = event.data as {
      orgId: string;
      workspaceId: string;
      executionId: string;
      stepId: string;
      taskIndex: number;
      goal: string;
      outputFormat: string;
    };

    // Deterministic — not crypto.randomUUID() — so a replayed/retried
    // invocation of this function derives the same tool_invocations row id
    // rather than minting a fresh random one on every re-execution. The
    // actual double-insert guard is the step.run wrapper around each
    // insertToolInvocation call below (see OXA reliability fix: retried
    // Inngest steps double-counting ClickHouse telemetry).
    const invocationId = deterministicEventId(
      "agent.workflow.task.execute",
      stepId,
    );
    const startedAt = Date.now();
    const workerId =
      typeof runId === "string" && runId.length > 0
        ? runId
        : `worker:${stepId}`;

    // Claim the step (mark-running as a claim — spec §1): atomic UPDATE that
    // takes ownership + a lease and bumps attempts. Null means the step is
    // terminal, at the attempt cap, or owned by a live worker — skipping makes
    // duplicate deliveries and sweeper re-dispatches safe instead of
    // double-running the task.
    const claimed = await step.run("claim-step", () =>
      claimExecutionStep({ orgId, workspaceId, stepId, workerId }),
    );
    if (!claimed) {
      logger.info(
        { stepId, executionId, orgId },
        "agent.workflow.task.execute: step not claimable (terminal, capped, or live-owned) — skipping",
      );
      return { stepId, taskIndex, status: "skipped" };
    }

    let output: z.output<typeof taskOutputSchema>;
    try {
      const result = await step.run("execute", async () => {
        // Keep the lease alive across the LLM call so a slow generation never
        // triggers a false reclaim (spec §Risks).
        const stopRenewal = startLeaseRenewal(
          () =>
            renewExecutionStepLease({ orgId, workspaceId, stepId, workerId }),
          {
            onError: (err) =>
              logger.warn(
                { err, stepId },
                "lease renewal failed — sweeper may reclaim",
              ),
          },
        );
        try {
          return await generateObjectFor({
            schema: taskOutputSchema,
            system: `You are a research agent. Given a specific research goal, produce a concise structured result.
Provide a summary, any relevant structured data, and source references if applicable.`,
            prompt: `Research goal: ${goal}\n\nProvide your findings as structured output. Output format: ${outputFormat}.`,
            telemetry: {
              orgId,
              workspaceId,
              surface: "runner" as const,
              messageId: stepId,
            },
          });
        } finally {
          stopRenewal();
        }
      });
      output = result.object;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { stepId, executionId, orgId, err },
        "agent.workflow.task.execute: failed",
      );

      await step.run("mark-failed", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.agentExecutionSteps)
              .set({
                status: "failed",
                failureReason: errMsg,
                completedAt: new Date(),
                updatedAt: new Date(),
                leaseExpiresAt: null,
              })
              .where(
                and(
                  eq(schema.agentExecutionSteps.id, stepId),
                  eq(schema.agentExecutionSteps.orgId, orgId),
                ),
              ),
          ),
        ),
      );

      // Wrapped in its own memoized step so a retry/replay of this function
      // after this point never re-inserts the row (tool_invocations is a
      // plain append-only MergeTree — no dedup on re-insert).
      await step.run("emit-tool-invocation-failed", async () => {
        try {
          await insertToolInvocation({
            invocation_id: invocationId,
            org_id: orgId,
            workspace_id: workspaceId,
            capability_name: "workflow.task.execute",
            message_id: stepId,
            parent_message_id: executionId,
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
        } catch (telErr) {
          logger.warn(
            { err: telErr },
            "insertToolInvocation failed — telemetry loss",
          );
        }
      });

      throw err;
    }

    // Mark completed.
    await step.run("mark-completed", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.agentExecutionSteps)
            .set({
              status: "completed",
              outputPayload: output as object,
              completedAt: new Date(),
              updatedAt: new Date(),
              leaseExpiresAt: null,
            })
            .where(
              and(
                eq(schema.agentExecutionSteps.id, stepId),
                eq(schema.agentExecutionSteps.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    // Check if all steps for this execution are done.
    const stepCounts = await step.run("count-steps", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          // Single aggregating query: total, completed, and failed must be read
          // from one consistent snapshot. Three separate COUNT statements run at
          // independent READ COMMITTED snapshots, so a concurrent task completing
          // between them could make the terminal check (`completed + failed >=
          // total`) flip incorrectly — with concurrency up to 100/org this race
          // can leave an execution stuck non-final or finalize it twice.
          const [row] = await tx
            .select({
              total: count(schema.agentExecutionSteps.id),
              completed: sql<number>`count(*) filter (where ${schema.agentExecutionSteps.status} = 'completed')`,
              failed: sql<number>`count(*) filter (where ${schema.agentExecutionSteps.status} = 'failed')`,
            })
            .from(schema.agentExecutionSteps)
            .where(
              and(
                eq(schema.agentExecutionSteps.executionId, executionId),
                eq(schema.agentExecutionSteps.orgId, orgId),
              ),
            );
          return {
            total: Number(row?.total ?? 0),
            completed: Number(row?.completed ?? 0),
            failed: Number(row?.failed ?? 0),
          };
        }),
      ),
    );

    const { total, completed, failed } = stepCounts ?? {
      total: 0,
      completed: 0,
      failed: 0,
    };

    // If all steps are terminal, finalize the execution.
    if (completed + failed >= total) {
      const finalStatus = completed > 0 ? "completed" : "failed";
      await step.run("finalize-execution", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.agentExecutions)
              .set({
                status: finalStatus,
                completedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.agentExecutions.id, executionId)),
          ),
        ),
      );
    }

    // Wrapped in its own memoized step — see the failure-path comment above
    // for why.
    await step.run("emit-tool-invocation-completed", async () => {
      try {
        await insertToolInvocation({
          invocation_id: invocationId,
          org_id: orgId,
          workspace_id: workspaceId,
          capability_name: "workflow.task.execute",
          message_id: stepId,
          parent_message_id: executionId,
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
      } catch (telErr) {
        logger.warn(
          { err: telErr },
          "insertToolInvocation failed — telemetry loss",
        );
      }
    });

    logger.info(
      { stepId, taskIndex, executionId, orgId },
      "agent.workflow.task.execute: completed",
    );
    return { stepId, taskIndex, status: "completed" };
  },
);
