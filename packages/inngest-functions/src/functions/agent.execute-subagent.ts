import { inngest } from "../inngest.js";
import { db, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { invokeCapability } from "@oxagen/agent";
import "@oxagen/oxagen";

/**
 * Subagent fanout executor. Triggered by agent.subagent.dispatch via the
 * runtime's dispatchFanout(). Each child runs in its own step.run so
 * Inngest checkpoints around it; we never bail the whole fanout on one
 * child failure — the parent message aggregates partials.
 */
export const agentExecuteSubagent = inngest.createFunction(
  { id: "agent.execute-subagent", retries: 0, concurrency: { limit: 8, key: "event.data.tenantId" } },
  { event: "agent/subagent.dispatch" },
  async ({ event, step }) => {
    const { tenantId, workspaceId, fanoutId } = event.data;

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
            tenantId,
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

    const finalStatus = anyFailed && completed === 0 ? "completed" : completed === runs.length ? "completed" : "partial";
    await step.run("finalize", async () => {
      await db()
        .update(schema.subagentFanouts)
        .set({ status: finalStatus, completedChildren: completed })
        .where(
          and(eq(schema.subagentFanouts.id, fanoutId), eq(schema.subagentFanouts.tenantId, tenantId)),
        );
    });

    return { fanoutId, completed, status: finalStatus };
  },
);
