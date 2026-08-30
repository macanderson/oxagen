import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import { getInngestClient } from "../dispatch/inngest-client";
import type {
  AgentTaskBackgroundCancelInput,
  AgentTaskBackgroundCancelOutput,
} from "@oxagen/oxagen/contracts/agent.background_task.cancel";

export type { AgentTaskBackgroundCancelInput, AgentTaskBackgroundCancelOutput };

export async function agentTaskBackgroundCancelHandler(
  input: AgentTaskBackgroundCancelInput,
  ctx: CapabilityContext,
): Promise<AgentTaskBackgroundCancelOutput> {
  const [existing] = await withTenantDb((tx) =>
    tx
      .select({
        status: schema.backgroundTasks.status,
        id: schema.backgroundTasks.id,
      })
      .from(schema.backgroundTasks)
      .where(
        and(
          eq(schema.backgroundTasks.publicId, input.taskId),
          eq(schema.backgroundTasks.orgId, ctx.orgId),
          eq(schema.backgroundTasks.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1),
  );
  if (!existing) throw new Error(`Background task ${input.taskId} not found`);
  if (existing.status === "completed")
    return { taskId: input.taskId, status: "already_completed" };
  if (existing.status === "cancelled")
    return { taskId: input.taskId, status: "already_cancelled" };

  await withTenantDb((tx) =>
    tx
      .update(schema.backgroundTasks)
      .set({
        status: "cancelled",
        failureReason: input.reason ?? "cancelled by user",
        completedAt: new Date(),
      })
      .where(eq(schema.backgroundTasks.id, existing.id)),
  );

  await getInngestClient().send({
    name: "agent/task.background.cancel",
    data: { orgId: ctx.orgId, taskId: input.taskId },
  });

  return { taskId: input.taskId, status: "cancelled" };
}
