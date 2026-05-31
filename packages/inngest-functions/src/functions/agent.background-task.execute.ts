import { inngest } from "../inngest.js";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { invokeCapability } from "@oxagen/agent";
import "@oxagen/oxagen";
import { logger } from "../logger.js";

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

    await step.run("mark-running", async () => {
      await db()
        .update(schema.backgroundTasks)
        .set({ status: "running", startedAt: new Date() })
        .where(
          and(
            eq(schema.backgroundTasks.publicId, taskId),
            eq(schema.backgroundTasks.orgId, orgId),
          ),
        );
    });

    try {
      const output = await step.run("invoke", async () => {
        if (!p.capability) throw new Error("background task payload missing 'capability'");
        return invokeCapability(p.capability, p.input ?? p, {
          orgId,
          workspaceId,
          userId: null,
          apiKeyId: null,
          requestId: taskId,
          surface: "runner",
          messageId: null,
        });
      });
      await step.run("mark-completed", async () => {
        await db()
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
          );
      });
      logger.info({ taskId, orgId, workspaceId }, "agent.background-task.execute completed");
      return { taskId, status: "completed" };
    } catch (err) {
      await step.run("mark-failed", async () => {
        await db()
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
          );
      });
      logger.error({ taskId, orgId, err }, "agent.background-task.execute failed");
      throw err;
    }
  },
);
