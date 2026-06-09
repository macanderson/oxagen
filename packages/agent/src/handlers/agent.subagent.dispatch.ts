import { withTenantDb, schema } from "@oxagen/database";
import { getInngestClient } from "../dispatch/inngest-client";
import type { CapabilityContext } from "../types";
import type {
  AgentSubagentDispatchInput,
  AgentSubagentDispatchOutput,
} from "@oxagen/oxagen/contracts/agent.subagent.dispatch";

export type { AgentSubagentDispatchInput, AgentSubagentDispatchOutput };

export async function agentSubagentDispatchHandler(
  input: AgentSubagentDispatchInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentDispatchOutput> {
  const { parentMessageId, tasks, maxParallel = 5 } = input;

  const [fanout] = await withTenantDb((tx) =>
    tx
      .insert(schema.subagentFanouts)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        parentMessageId,
        status: "pending",
        totalChildren: tasks.length,
        completedChildren: 0,
      })
      .returning({ publicId: schema.subagentFanouts.publicId }),
  );
  if (!fanout) throw new Error("subagent_fanouts insert failed");

  await withTenantDb((tx) =>
    tx.insert(schema.subagentRuns).values(
      tasks.map((task, idx) => ({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        fanoutId: fanout.publicId,
        childMessageId: parentMessageId,
        capabilityName: task.capabilityName,
        inputPayload: (task.input ?? {}) as object,
        status: "pending" as const,
      })),
    ),
  );

  const runRows = await withTenantDb((tx) =>
    tx.query.subagentRuns.findMany({
      where: (t, { eq }) => eq(t.fanoutId, fanout.publicId),
      columns: { publicId: true, capabilityName: true, inputPayload: true },
    }),
  );

  await getInngestClient().send({
    name: "agent/subagent.dispatch",
    data: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      dispatchId: fanout.publicId,
      maxParallel,
      timeoutSeconds: input.timeoutSeconds,
      runs: runRows.map((r) => ({
        runId: r.publicId,
        capabilityName: r.capabilityName,
        input: r.inputPayload,
      })),
    },
  });

  return {
    dispatchId: fanout.publicId,
    totalTasks: tasks.length,
    status: "pending",
  };
}
