import { withTenantDb, schema } from "@oxagen/database";
import { getInngestClient } from "../dispatch/inngest-client";
import { getOxagenRegistry } from "../registry-loader";
import type { CapabilityContext } from "../types";
import type {
  AgentSubagentDispatchInput,
  AgentSubagentDispatchOutput,
} from "@oxagen/oxagen/contracts/agent.subagent.dispatch";

export type { AgentSubagentDispatchInput, AgentSubagentDispatchOutput };

// Per-risk-level ceiling (seconds) for a dispatched task. A caller-supplied
// timeoutSeconds is clamped to the ceiling of the riskiest capability in the
// batch so a single high-risk task can't be parked on the worker for the full
// contract max (3600s). Unknown/absent risk defaults to the medium ceiling.
const TIMEOUT_CEILING_BY_RISK: Record<"low" | "medium" | "high", number> = {
  low: 900,
  medium: 600,
  high: 300,
};

export async function agentSubagentDispatchHandler(
  input: AgentSubagentDispatchInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentDispatchOutput> {
  const { parentMessageId, tasks, maxParallel = 5 } = input;

  // Validate every capabilityName against the registry BEFORE creating any
  // rows. An unvalidated typo would otherwise persist a subagent_runs row the
  // worker can never execute (a silent dead run). Reject the whole batch with
  // a clear error, and compute the strictest timeout ceiling for the batch.
  const { getCapability } = await getOxagenRegistry();
  const unknownNames: string[] = [];
  let ceiling = TIMEOUT_CEILING_BY_RISK.low;
  for (const task of tasks) {
    const cap = getCapability(task.capabilityName);
    if (!cap) {
      unknownNames.push(task.capabilityName);
      continue;
    }
    const risk = cap.agent?.riskLevel ?? "medium";
    ceiling = Math.min(ceiling, TIMEOUT_CEILING_BY_RISK[risk]);
  }
  if (unknownNames.length > 0) {
    throw new Error(
      `Unknown capability name(s) in dispatch: ${[...new Set(unknownNames)].join(", ")}`,
    );
  }

  // Clamp the (already 1..3600-bounded) timeout to the batch risk ceiling.
  const timeoutSeconds =
    input.timeoutSeconds === undefined
      ? undefined
      : Math.min(input.timeoutSeconds, ceiling);

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
      tasks.map((task) => ({
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
      timeoutSeconds,
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
