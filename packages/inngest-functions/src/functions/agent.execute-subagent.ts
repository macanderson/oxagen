import { inngest } from "../inngest.js";
import { db, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { invokeCapability } from "@oxagen/agent";
import "@oxagen/oxagen";
import { logger } from "../logger.js";

/** Pure helper — exported for unit testing. */
export function deriveFanoutStatus(
  completed: number,
  total: number,
  anyFailed: boolean,
): "completed" | "failed" | "partial" {
  if (completed === total) return "completed";
  if (anyFailed && completed === 0) return "failed";
  return "partial";
}

/**
 * Subagent fanout executor. Triggered by agent.subagent.dispatch via the
 * runtime's dispatchFanout(). Each child runs in its own step.run so
 * Inngest checkpoints around it; we never bail the whole fanout on one
 * child failure — the parent message aggregates partials.
 */
export const agentExecuteSubagent = inngest.createFunction(
  { id: "agent.execute-subagent", retries: 0, concurrency: { limit: 8, key: "event.data.orgId" } },
  { event: "agent/subagent.dispatch" },
  async ({ event, step }) => {
    const { orgId, workspaceId, fanoutId } = event.data;

    const runs = await step.run("load-children", async () =>
      db()
        .select()
        .from(schema.subagentRuns)
        .where(eq(schema.subagentRuns.fanoutId, fanoutId)),
    );

    await step.run("mark-running", async () => {
      await db()
        .update(schema.subagentFanouts)
        .set({ status: "running" })
        .where(eq(schema.subagentFanouts.id, fanoutId));
    });

    let completed = 0;
    let anyFailed = false;
    for (const r of runs) {
      const childOk = await step.run(`child-${r.id}`, async () => {
        try {
          const output = await invokeCapability(r.capabilityName, r.inputPayload, {
            orgId,
            workspaceId,
            userId: null,
            apiKeyId: null,
            requestId: r.childMessageId,
            surface: "runner",
            messageId: r.childMessageId,
          });
          await db()
            .update(schema.subagentRuns)
            .set({ status: "completed", outputPayload: (output ?? null) as object, completedAt: new Date() })
            .where(eq(schema.subagentRuns.id, r.id));
          return true;
        } catch (err) {
          await db()
            .update(schema.subagentRuns)
            .set({
              status: "failed",
              errorReason: err instanceof Error ? err.message : String(err),
              completedAt: new Date(),
            })
            .where(eq(schema.subagentRuns.id, r.id));
          return false;
        }
      });
      if (childOk) completed++;
      else anyFailed = true;
    }

    const finalStatus = deriveFanoutStatus(completed, runs.length, anyFailed);
    await step.run("finalize", async () => {
      await db()
        .update(schema.subagentFanouts)
        .set({ status: finalStatus, completedChildren: completed })
        .where(
          and(eq(schema.subagentFanouts.id, fanoutId), eq(schema.subagentFanouts.orgId, orgId)),
        );
    });

    logger.info({ fanoutId, completed, total: runs.length, status: finalStatus }, "agent.execute-subagent complete");
    return { fanoutId, completed, status: finalStatus };
  },
);
