import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { researchSwarmStart } from "@oxagen/oxagen/contracts/research.swarm.start";
import { invoke } from "@oxagen/oxagen/kernel";
import type { AgentSubagentDispatchOutput } from "@oxagen/oxagen/contracts/agent.subagent.dispatch";
import { storeSwarm } from "./research.swarm.store";
import { logger } from "./logger";

// TODO: OXA-XXXX wire result aggregation to graph.node.upsert via agent.subagent.aggregate once results land

const DEPTH_QUERY_COUNTS: Record<string, number> = {
  shallow: 3,
  medium: 8,
  deep: 15,
};

const queriesSchema = z.object({
  queries: z.array(z.string()).min(1).max(15),
});

export const researchSwarmStartHandler: CapabilityHandler<typeof researchSwarmStart> = async (
  input,
  ctx,
) => {
  const queryCount = DEPTH_QUERY_COUNTS[input.depth] ?? 8;

  // Generate diverse search queries for the topic using the AI layer.
  const { object } = await generateObjectFor({
    schema: queriesSchema,
    prompt: `Generate ${queryCount} diverse web search queries to comprehensively research this topic: ${input.topic}. Return JSON { queries: string[] }`,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      messageId: ctx.messageId ?? ctx.requestId,
    },
  });

  const queries = object.queries.slice(0, queryCount);

  // Fan out a web.search task per query via agent.subagent.dispatch.
  // The agent.subagent.dispatch handler is registered at boot by @oxagen/agent/register.
  const dispatchResult = (await invoke(
    "agent.subagent.dispatch",
    {
      parentMessageId: ctx.messageId ?? ctx.requestId,
      maxParallel: input.maxParallel,
      tasks: queries.map((query) => ({
        capabilityName: "web.search",
        input: {
          query,
          maxResults: 5,
          searchDepth: input.searchDepth,
        },
      })),
    },
    ctx,
  )) as AgentSubagentDispatchOutput;

  const swarmId = randomUUID();

  // Store the swarmId → dispatchId mapping for status polling.
  storeSwarm(swarmId, {
    dispatchId: dispatchResult.dispatchId,
    totalTasks: queries.length,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  });

  logger.info(
    {
      swarmId,
      dispatchId: dispatchResult.dispatchId,
      topic: input.topic,
      depth: input.depth,
      queryCount: queries.length,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "research.swarm.start: dispatched",
  );

  return {
    swarmId,
    dispatchId: dispatchResult.dispatchId,
    status: "running" as const,
    estimatedTasks: queries.length,
  };
};
