import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { Inngest } from "inngest";
import { loadEnv } from "@oxagen/config/env";
import type { CapabilityContext } from "../types.js";
import type { AgentTaskBackgroundCancelInput, AgentTaskBackgroundCancelOutput } from "@oxagen/oxagen/contracts/agent.task.background.cancel";

export type { AgentTaskBackgroundCancelInput, AgentTaskBackgroundCancelOutput };

const env = loadEnv();
const inngest = new Inngest({ id: "oxagen-runner", eventKey: env.INNGEST_EVENT_KEY });

export async function agentTaskBackgroundCancelHandler(
  input: AgentTaskBackgroundCancelInput,
  ctx: CapabilityContext,
): Promise<AgentTaskBackgroundCancelOutput> {
  const [existing] = await db()
    .select({ status: schema.backgroundTasks.status, id: schema.backgroundTasks.id })
    .from(schema.backgroundTasks)
    .where(
      and(
        eq(schema.backgroundTasks.publicId, input.taskId),
        eq(schema.backgroundTasks.orgId, ctx.orgId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error(`Background task ${input.taskId} not found`);
  if (existing.status === "completed") return { taskId: input.taskId, status: "already_completed" };
  if (existing.status === "cancelled") return { taskId: input.taskId, status: "already_cancelled" };

  await db()
    .update(schema.backgroundTasks)
    .set({ status: "cancelled", failureReason: input.reason ?? "cancelled by user", completedAt: new Date() })
    .where(eq(schema.backgroundTasks.id, existing.id));

  await inngest.send({
    name: "agent/task.background.cancel",
    data: { orgId: ctx.orgId, taskId: input.taskId },
  });

  return { taskId: input.taskId, status: "cancelled" };
}
