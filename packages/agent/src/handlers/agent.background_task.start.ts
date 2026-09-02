import { withTenantDb, schema } from "@oxagen/database";
import type { CapabilityContext } from "../types";
import { getInngestClient } from "../dispatch/inngest-client";
import type {
  AgentTaskBackgroundStartInput,
  AgentTaskBackgroundStartOutput,
} from "@oxagen/oxagen/contracts/agent.background_task.start";

export type { AgentTaskBackgroundStartInput, AgentTaskBackgroundStartOutput };

export async function agentTaskBackgroundStartHandler(
  input: AgentTaskBackgroundStartInput,
  ctx: CapabilityContext,
): Promise<AgentTaskBackgroundStartOutput> {
  // We allocate a deterministic inngest run id locally; the runner echoes
  // it back when the function actually starts. The row is the durable
  // handle the chat tray polls.
  const inngestRunId = `bgt_${crypto.randomUUID()}`;
  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.backgroundTasks)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        label: input.label ?? null,
        inngestRunId,
        status: "pending",
        inputPayload: (input.payload ?? null) as object,
        createdByUserId: ctx.userId,
      })
      .returning({ publicId: schema.backgroundTasks.publicId }),
  );
  if (!row) throw new Error("background_tasks insert failed");

  await getInngestClient().send({
    name: "agent/task.background.start",
    data: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      taskId: row.publicId,
      kind: input.kind,
      payload: input.payload,
    },
  });

  return { taskId: row.publicId, inngestRunId };
}
