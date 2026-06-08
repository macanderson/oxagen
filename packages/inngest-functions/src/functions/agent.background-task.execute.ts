import { inngest } from "../inngest";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { invoke } from "@oxagen/oxagen/kernel";
import { insertToolInvocation } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import "@oxagen/oxagen";
import { logger } from "../logger";

/**
 * Background task executor. The payload's `capability` field names the
 * capability to invoke; anything else is fed in as its input. A failure
 * captures the error reason on the row but does not retry — the user
 * sees the failure surface in the tray and decides whether to re-issue.
 */
interface BgPayload {
  capability?: string;
  input?: unknown;
  [k: string]: unknown;
}

export const agentBackgroundTaskExecute = inngest.createFunction(
  {
    id: "agent.background-task.execute",
    retries: 0,
    concurrency: { limit: 16, key: "event.data.orgId" },
    // Cancel the in-flight Inngest execution when the cancel event arrives for
    // the same task + org. Without cancelOn the DB row is marked cancelled but
    // the execution continues running until it finishes naturally.
    cancelOn: [
      {
        event: "agent/task.background.cancel",
        if: "event.data.taskId == async.data.taskId && event.data.orgId == async.data.orgId",
      },
    ],
  },
  { event: "agent/task.background.start" },
  async ({ event, step }) => {
    const { orgId, workspaceId, taskId, payload } = event.data;
    const p = (payload ?? {}) as BgPayload;

    await step.run("mark-running", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.backgroundTasks)
            .set({ status: "running", startedAt: new Date() })
            .where(
              and(
                eq(schema.backgroundTasks.publicId, taskId),
                eq(schema.backgroundTasks.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    const invocationId = crypto.randomUUID();
    const startedAt = Date.now();
    const capabilityName = p.capability;

    try {
      const output = await step.run("invoke", async () => {
        if (!capabilityName) throw new Error("background task payload missing 'capability'");
        const ctx = {
          orgId,
          workspaceId,
          userId: null,
          apiKeyId: null,
          requestId: taskId,
          surface: "runner" as const,
          messageId: null,
        };
        // Route through kernel.invoke() for IAM enforcement, audit, and
        // uniform metering (OXA-1498 — previously bypassed via invokeCapability).
        return invoke(capabilityName, p.input ?? p, ctx);
      });
      await step.run("mark-completed", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.backgroundTasks)
              .set({
                status: "completed",
                resultPayload: (output ?? null) as object,
                completedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.backgroundTasks.publicId, taskId),
                  eq(schema.backgroundTasks.orgId, orgId),
                ),
              ),
          ),
        ),
      );
      // Write tool_invocations row for metering (OXA-1498).
      try {
        await insertToolInvocation({
          invocation_id: invocationId,
          org_id: orgId,
          workspace_id: workspaceId,
          capability_name: capabilityName ?? "unknown",
          message_id: taskId,
          parent_message_id: null,
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
        logger.warn({ err: telErr }, 'insertToolInvocation failed — telemetry loss');
      }
      logger.info({ taskId, orgId, workspaceId }, "agent.background-task.execute completed");
      return { taskId, status: "completed" };
    } catch (err) {
      await step.run("mark-failed", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.backgroundTasks)
              .set({
                status: "failed",
                failureReason: err instanceof Error ? err.message : String(err),
                completedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.backgroundTasks.publicId, taskId),
                  eq(schema.backgroundTasks.orgId, orgId),
                ),
              ),
          ),
        ),
      );
      // Write failed metering row.
      try {
        await insertToolInvocation({
          invocation_id: invocationId,
          org_id: orgId,
          workspace_id: workspaceId,
          capability_name: capabilityName ?? "unknown",
          message_id: taskId,
          parent_message_id: null,
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
        logger.warn({ err: telErr }, 'insertToolInvocation failed — telemetry loss');
      }
      logger.error({ taskId, orgId, err }, "agent.background-task.execute failed");
      throw err;
    }
  },
);
