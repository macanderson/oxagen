import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { researchSwarmStart } from "@oxagen/oxagen/contracts/research.swarm.start";
import { invoke } from "@oxagen/oxagen/kernel";
import type { AgentSubagentDispatchOutput } from "@oxagen/oxagen/contracts/agent.subagent.dispatch";
import { logger } from "./logger";

// Search results remain task output. They are not auto-materialized into the
// governed workspace graph; promotion requires a future typed, attributable
// context/evidence contract.

const DEPTH_QUERY_COUNTS: Record<string, number> = {
  shallow: 3,
  medium: 8,
  deep: 15,
};

const queriesSchema = z.object({
  queries: z.array(z.string()).min(1).max(15),
});

export const researchSwarmStartHandler: CapabilityHandler<
  typeof researchSwarmStart
> = async (input, ctx) => {
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

  // Fan out one search_web task per query via dispatch_subagent, whose handler
  // is registered at boot by @oxagen/agent/register.
  const dispatchResult = (await invoke(
    "dispatch_subagent",
    {
      parentMessageId: ctx.messageId ?? ctx.requestId,
      maxParallel: input.maxParallel,
      tasks: queries.map((query) => ({
        capabilityName: "search_web",
        input: {
          query,
          maxResults: 5,
          searchDepth: input.searchDepth,
        },
      })),
    },
    ctx,
  )) as AgentSubagentDispatchOutput;

  // The swarm IS its subagent fanout, so the swarmId must be the fanout's
  // durable public_id — it is persisted in Postgres and tenant-scoped by
  // aggregate_subagents, so get_research_status resolves it from any process.
  // A locally-minted id would only be resolvable in the process that started
  // the swarm.
  const swarmId = dispatchResult.dispatchId;

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
