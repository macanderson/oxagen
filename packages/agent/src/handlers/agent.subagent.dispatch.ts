import { withTenantDb, schema } from "@oxagen/database";
import { randomUUID } from "node:crypto";
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

  // Capture BOTH ids: the internal uuid `id` is the foreign key stored on
  // subagent_runs.fanout_id (a uuid column) and the key the Inngest executor
  // matches on; the `publicId` is the external handle returned to callers and
  // accepted by agent.subagent.aggregate / agent.subagent.fanout.get.
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
      .returning({
        id: schema.subagentFanouts.id,
        publicId: schema.subagentFanouts.publicId,
      }),
  );
  if (!fanout) throw new Error("subagent_fanouts insert failed");

  // Single batch insert; never per-child loop (N+1 violation). fanout_id is the
  // fan-out's uuid (FK to subagent_fanouts.id), and each child gets its OWN
  // unique childMessageId — reusing parentMessageId across rows is wrong (the
  // executor uses it as the per-child message/request id).
  await withTenantDb((tx) =>
    tx.insert(schema.subagentRuns).values(
      tasks.map((task) => ({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        fanoutId: fanout.id,
        childMessageId: randomUUID(),
        capabilityName: task.capabilityName,
        inputPayload: (task.input ?? {}) as object,
        status: "pending" as const,
      })),
    ),
  );

  // The executor (agent.execute-subagent) reads `fanoutId` (the uuid) and loads
  // the child runs from the DB itself, so we do not re-send them here. depth=1:
  // children execute one level below this root dispatch (OXA-1498 depth guard).
  await getInngestClient().send({
    name: "agent/subagent.dispatch",
    data: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      fanoutId: fanout.id,
      depth: 1,
      maxParallel,
      timeoutSeconds,
    },
  });

  return {
    dispatchId: fanout.publicId,
    totalTasks: tasks.length,
    status: "pending",
  };
}
