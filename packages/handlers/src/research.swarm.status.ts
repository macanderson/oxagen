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

  // Delegate to agent.subagent.aggregate. The aggregate is ALWAYS a non-blocking
  // snapshot (it never sleeps), so we do NOT pass timeoutMs:0 — `timeoutMs` is the
  // *staleness window*, i.e. how old a still-running fanout may be before it is
  // reported as `timed_out`. Passing 0 made every in-flight swarm read as
  // timed_out (age 0 >= 0) → mapped to "failed", so a running swarm never showed
  // progress and never completed. Omit it to use the contract default window.
  const aggregateResult = (await invoke(
    "agent.subagent.aggregate",
    {
      fanoutId: record.dispatchId,
    },
    ctx,
  )) as AgentSubagentAggregateOutput;

  const status = mapStatus(aggregateResult.status);

  // Surface the ACTUAL web-search hits per query. Each child is a web.search run
  // whose input carries the query and whose output carries { results: [...] }.
  // (Previously this data was computed by aggregate but dropped here — the core
  // "the swarm data is useless" bug. Now it flows back to the agent + UI.)
  const results = mapChildrenToResults(aggregateResult.children);

  logger.info(
    {
      swarmId: input.swarmId,
      dispatchId: record.dispatchId,
      aggregateStatus: aggregateResult.status,
      swarmStatus: status,
      completedChildren: aggregateResult.completedChildren,
      totalChildren: aggregateResult.totalChildren,
      queriesWithResults: results.length,
    },
    "research.swarm.status: polled",
  );

  return {
    swarmId: input.swarmId,
    dispatchId: record.dispatchId,
    status,
    completedTasks: aggregateResult.completedChildren,
    totalTasks: aggregateResult.totalChildren,
    ...(results.length > 0 ? { results } : {}),
  };
};

interface SwarmQueryResult {
  query: string;
  resultCount: number;
  hits: Array<{ title: string; url: string; snippet: string; score?: number }>;
}

/**
 * Map aggregate children (web.search runs) → the per-query results the swarm
 * collected. Defensive about payload shapes since outputPayload is `unknown`.
 */
export function mapChildrenToResults(
  children: AgentSubagentAggregateOutput["children"],
): SwarmQueryResult[] {
  const out: SwarmQueryResult[] = [];
  // Defensive: a malformed/older aggregate payload (or a future shape change)
  // could omit `children`. Iterating undefined throws "children is not iterable"
  // and fails the whole status poll — degrade to "no results yet" instead.
  if (!Array.isArray(children)) return out;
  for (const child of children) {
    const input = asRecord(child.input);
    const output = asRecord(child.output);
    const query = typeof input?.query === "string" ? input.query : "";
    const rawHits = Array.isArray(output?.results) ? output.results : [];
    const hits = rawHits.flatMap((h): SwarmQueryResult["hits"] => {
      const hit = asRecord(h);
      if (!hit || typeof hit.url !== "string" || typeof hit.title !== "string") return [];
      return [
        {
          title: hit.title,
          url: hit.url,
          snippet: typeof hit.content === "string" ? hit.content.slice(0, 500) : "",
          ...(typeof hit.score === "number" ? { score: hit.score } : {}),
        },
      ];
    });
    if (query.length === 0 && hits.length === 0) continue;
    const resultCount =
      typeof output?.totalResults === "number" ? output.totalResults : hits.length;
    out.push({ query, resultCount, hits });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
