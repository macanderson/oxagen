import { z } from "zod";
import { registerCapability } from "../registry";

export const researchSwarmStatus = registerCapability({
  name: "get_research_status",
  domain: "research",
  description:
    "Poll the status of a running research swarm. Returns task completion progress and the web-search results collected by each subagent so the agent can summarize or package them as a governed artifact. Delegates to aggregate_subagents internally.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "research" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // After a swarm completes, the agent reads `results` to summarize for the
  // user or package the findings as an explicit artifact. Search results are
  // never promoted into the workspace graph as a hidden side effect.
  produces: ["search.results"],
  consumes: ["swarm.id"],
  chainHints: ["generate_document"],
  render: { componentId: "research-swarm-card" },
  input: z.object({
    swarmId: z.string().describe("Swarm ID returned by start_research_swarm"),
  }),
  output: z.object({
    swarmId: z.string(),
    dispatchId: z.string(),
    status: z.enum(["running", "complete", "failed"]),
    completedTasks: z.number(),
    totalTasks: z.number(),
    results: z
      .array(
        z.object({
          query: z.string(),
          resultCount: z.number(),
          hits: z
            .array(
              z.object({
                title: z.string(),
                url: z.string(),
                snippet: z.string(),
                score: z.number().optional(),
              }),
            )
            .default([])
            .describe("The actual search hits for this query"),
        }),
      )
      .optional()
      .describe(
        "Per-query results — the real web-search hits each swarm subagent collected, " +
          "present once the swarm has produced output. This is the data to summarize " +
          "and ingest into the knowledge graph.",
      ),
  }),
});

export type ResearchSwarmStatusInput = z.output<
  typeof researchSwarmStatus.input
>;
export type ResearchSwarmStatusOutput = z.output<
  typeof researchSwarmStatus.output
>;
