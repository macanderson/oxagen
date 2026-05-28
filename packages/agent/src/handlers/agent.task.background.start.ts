import { db, schema } from "@oxagen/database";
import { Inngest } from "inngest";
import { loadEnv } from "@oxagen/config/env";
import type { CapabilityContext } from "../types.js";

const env = loadEnv();
const inngest = new Inngest({ id: "oxagen-runner", eventKey: env.INNGEST_EVENT_KEY });

export interface AgentTaskBackgroundStartInput {
  kind: string;
  payload: unknown;
  label?: string;
}

export interface AgentTaskBackgroundStartOutput {
  taskId: string;
  inngestRunId: string;
}

export async function agentTaskBackgroundStartHandler(
  input: AgentTaskBackgroundStartInput,
  ctx: CapabilityContext,
): Promise<AgentTaskBackgroundStartOutput> {
  // We allocate a deterministic inngest run id locally; the runner echoes
  // it back when the function actually starts. The row is the durable
  // handle the chat tray polls.
  const inngestRunId = `bgt_${crypto.randomUUID()}`;
  const [row] = await db()
    .insert(schema.backgroundTasks)
    .values({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      kind: input.kind,
      label: input.label ?? null,
      inngestRunId,
      status: "pending",
      inputPayload: (input.payload ?? null) as object,
      createdByUserId: ctx.userId,
    })
    .returning({ publicId: schema.backgroundTasks.publicId });
  if (!row) throw new Error("background_tasks insert failed");

  await inngest.send({
    name: "agent/task.background.start",
    data: {
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      taskId: row.publicId,
      kind: input.kind,
      payload: input.payload,
    },
  });

  return { taskId: row.publicId, inngestRunId };
}
