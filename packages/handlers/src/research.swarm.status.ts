import type { CapabilityHandler } from "@oxagen/oxagen";
import { researchSwarmStatus } from "@oxagen/oxagen/contracts/research.swarm.status";
import { invoke } from "@oxagen/oxagen/kernel";
import type { AgentSubagentAggregateOutput } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { lookupSwarm } from "./research.swarm.store";
import { logger } from "./logger";

// Maps aggregate fanout status → swarm status for the research domain.
function mapStatus(
  aggregateStatus: AgentSubagentAggregateOutput["status"],
): "running" | "complete" | "failed" {
  switch (aggregateStatus) {
    case "completed":
      return "complete";
    case "partial":
      return "complete";
    case "failed":
      return "failed";
    case "timed_out":
      return "failed";
    default:
      return "running";
  }
}

export const researchSwarmStatusHandler: CapabilityHandler<typeof researchSwarmStatus> = async (
  input,
  ctx,
) => {
  const record = lookupSwarm(input.swarmId, ctx.orgId, ctx.workspaceId);
  if (!record) {
    logger.warn(
      { swarmId: input.swarmId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "research.swarm.status: swarm not found",
    );
    throw new Error(`research.swarm.status: swarm ${input.swarmId} not found`);
  }

  // Delegate to agent.subagent.aggregate with a short non-blocking timeout (0ms
  // = return current state immediately without polling).
  const aggregateResult = (await invoke(
    "agent.subagent.aggregate",
    {
      fanoutId: record.dispatchId,
      timeoutMs: 0,
    },
    ctx,
  )) as AgentSubagentAggregateOutput;

  const status = mapStatus(aggregateResult.status);

  logger.info(
    {
      swarmId: input.swarmId,
      dispatchId: record.dispatchId,
      aggregateStatus: aggregateResult.status,
      swarmStatus: status,
      completedChildren: aggregateResult.completedChildren,
      totalChildren: aggregateResult.totalChildren,
    },
    "research.swarm.status: polled",
  );

  return {
    swarmId: input.swarmId,
    dispatchId: record.dispatchId,
    status,
    completedTasks: aggregateResult.completedChildren,
    totalTasks: aggregateResult.totalChildren,
  };
};
