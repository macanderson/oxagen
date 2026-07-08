import { z } from "zod";
import { registerCapability } from "../registry";

export const researchSwarmStatus = registerCapability({
  name: "get_research_status",
  domain: "research",
  description:
    "Poll the status of a running research swarm. Returns task completion progress AND the actual web-search results collected by each subagent — title, url, and content snippet per hit — so the agent can summarize them and feed them into graph ingestion. Delegates to agent.subagent.aggregate internally.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "research" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // After a swarm completes, the agent reads `results` to (a) summarize for the
  // user and (b) feed the collected text into graph.ingest for entity/edge
  // extraction. graph.ingest is the natural next step.
  produces: ["search.results"],
  consumes: ["swarm.id"],
  chainHints: ["ingest_graph", "generate_document"],
  render: { componentId: "research-swarm-card" },
  input: z.object({
    swarmId: z.string().describe("Swarm ID returned by research.swarm.start"),
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

export type ResearchSwarmStatusInput = z.output<typeof researchSwarmStatus.input>;
export type ResearchSwarmStatusOutput = z.output<typeof researchSwarmStatus.output>;
