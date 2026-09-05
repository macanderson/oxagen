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

    // The mark-running UPDATE already targets this exact row by publicId, so
    // asking it to RETURNING the row's real uuid `id` gets us the one piece
    // of run identity this function is missing — no Inngest event/wire
    // change needed (#2656). `taskId` (backgroundTasks.publicId, "bgt_...")
    // is a citext string and stays the correlation key for every update
    // against this row below; `taskUuid` is the row's actual UUID primary
    // key and is the only thing safe to hand to a UUID-typed telemetry
    // column. `taskUuid` is `null` rather than a guess when the row can't be
    // found — see the emit-tool-invocation-* steps below for why that
    // absence must stay absence instead of being papered over.
    const [markRunningRow] = await step.run("mark-running", () =>
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
            )
            .returning({ id: schema.backgroundTasks.id }),
        ),
      ),
    );
    const taskUuid = markRunningRow?.id ?? null;
    if (!taskUuid) {
      // The row this function was dispatched for doesn't exist (or isn't in
      // this org) — surprising, since agent.background_task.start just
      // inserted it, but not impossible (e.g. a concurrent hard-delete).
      // Nothing downstream has a real uuid to attribute telemetry to.
      logger.warn(
        { taskId, orgId, workspaceId },
        "background_tasks row not found on mark-running — tool_invocations telemetry cannot be attributed to this run",
      );
    }

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
        // correlation key (#2597/#2615) — the same taskUuid used below as
        // this invocation's message_id, so a tool_invocations row and any
        // token_usage the capability incurs join on the same value. Both
        // must be the row's real uuid: CapabilityContext.executionStepId's
        // own contract is "the correlation key every telemetry table means
        // by execution_step_id" (packages/oxagen/src/types.ts), and every
        // execution_step_id column that key reaches is UUID-typed (#2656).
        // requestId keeps taskId (the public id) — it is a free-form
        // correlation string everywhere else in the platform (see
        // agent.sandbox-reaper.ts's "sandbox-reaper:<id>"), not a UUID
        // column value, so the public id is the more useful one for logs.
        const ctx = {
          orgId,
          workspaceId,
          userId: null,
          apiKeyId: null,
          requestId: taskId,
          surface: "runner" as const,
          messageId: null,
          executionStepId: taskUuid,
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
        // message_id is a non-nullable UUID column (#2656) — with no real
        // uuid for this run, absence must stay absence: skip the row rather
        // than write a fabricated id that would join to nothing (or worse,
        // to the wrong thing).
        if (!taskUuid) {
          logger.warn(
            { taskId, orgId, workspaceId },
            "no background_tasks row uuid — skipping tool_invocations insert",
          );
          return;
        }
        try {
          await insertToolInvocation({
            invocation_id: invocationId,
            org_id: orgId,
            workspace_id: workspaceId,
            capability_name: capabilityName ?? "unknown",
            message_id: taskUuid,
            parent_message_id: null,
            execution_step_id: taskUuid,
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
        // Same absence-stays-absence guard as the completed path above.
        if (!taskUuid) {
          logger.warn(
            { taskId, orgId, workspaceId },
            "no background_tasks row uuid — skipping tool_invocations insert",
          );
          return;
        }
        try {
          await insertToolInvocation({
            invocation_id: invocationId,
            org_id: orgId,
            workspace_id: workspaceId,
            capability_name: capabilityName ?? "unknown",
            message_id: taskUuid,
            parent_message_id: null,
            execution_step_id: taskUuid,
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
