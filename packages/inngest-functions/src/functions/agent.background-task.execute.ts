import { createFunction } from "../create-function";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { invoke } from "@oxagen/oxagen/kernel";
import { insertToolInvocation, deterministicEventId } from "@oxagen/telemetry";
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

export const [agentBackgroundTaskExecute] = createFunction(
  {
    id: "agent.background-task.execute",
    retries: 0,
    concurrency: { limit: 5, key: "event.data.orgId" },
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
    const { orgId, workspaceId, taskId, payload } = event.data as {
      orgId: string;
      workspaceId: string;
      taskId: string;
      payload?: Record<string, unknown>;
    };
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

    // Deterministic — not crypto.randomUUID() — so a replayed/retried
    // invocation of this function derives the same tool_invocations row id
    // rather than minting a fresh random one each time the function body
    // re-executes. The actual double-insert guard is the step.run wrapper
    // around each insertToolInvocation call below (see OXA reliability
    // fix: retried Inngest steps double-counting ClickHouse telemetry).
    const invocationId = deterministicEventId(
      "agent.background-task.execute",
      taskId,
    );
    const startedAt = Date.now();
    const capabilityName = p.capability;

    try {
      const output = await step.run("invoke", async () => {
        if (!capabilityName)
          throw new Error("background task payload missing 'capability'");
        // executionStepId names this background task's own run as the
        // correlation key (#2597/#2615) — the same taskId already used below
        // as this invocation's message_id, so a tool_invocations row and any
        // token_usage the capability incurs join on the same value.
        //
        // taskId is backgroundTasks.publicId ("bgt_..."), not a UUID, while
        // ClickHouse's message_id/execution_step_id columns are UUID-typed —
        // a pre-existing defect (#2656) that predates this fix and already
        // made every insertToolInvocation call below fail silently. The real
        // fix is plumbing the row's actual uuid id through the Inngest event;
        // this file has no other run identity to give until that lands.
        const ctx = {
          orgId,
          workspaceId,
          userId: null,
          apiKeyId: null,
          requestId: taskId,
          surface: "runner" as const,
          messageId: null,
          executionStepId: taskId,
        };
        // Route through kernel.invoke() for IAM enforcement, audit, and
        // uniform metering.
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
      // Write tool_invocations row for metering. This runs in its own
      // memoized step so a retry/replay of this function after this
      // point never re-inserts the row (tool_invocations is a plain
      // append-only MergeTree — no dedup on re-insert).
      await step.run("emit-tool-invocation-completed", async () => {
        try {
          await insertToolInvocation({
            invocation_id: invocationId,
            org_id: orgId,
            workspace_id: workspaceId,
            capability_name: capabilityName ?? "unknown",
            message_id: taskId,
            parent_message_id: null,
            execution_step_id: taskId,
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
        { taskId, orgId, workspaceId },
        "agent.background-task.execute completed",
      );
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
      // Write failed metering row. Wrapped in its own memoized step — see
      // the completed-path comment above for why.
      await step.run("emit-tool-invocation-failed", async () => {
        try {
          await insertToolInvocation({
            invocation_id: invocationId,
            org_id: orgId,
            workspace_id: workspaceId,
            capability_name: capabilityName ?? "unknown",
            message_id: taskId,
            parent_message_id: null,
            execution_step_id: taskId,
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
      logger.error(
        { taskId, orgId, err },
        "agent.background-task.execute failed",
      );
      throw err;
    }
  },
);
