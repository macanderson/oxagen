import { z } from "zod";
import { registerCapability } from "../registry";

export const researchSwarmStart = registerCapability({
  name: "start_research_swarm",
  domain: "research",
  description:
    "Fan out parallel web searches for a topic, generate diverse query variations, and dispatch them as concurrent subagent tasks. Returns a swarmId to poll via get_research_status.",
  mode: "async",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "research" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    topic: z
      .string()
      .min(1)
      .max(500)
      .describe("The research topic to investigate"),
    depth: z
      .enum(["shallow", "medium", "deep"])
      .default("medium")
      .describe("Research depth: shallow=3 searches, medium=8, deep=15"),
    maxParallel: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of concurrent search tasks"),
    targetLabel: z
      .string()
      .default("Topic")
      .describe(
        "KnowledgeNode label for top-level nodes created from research",
      ),
    searchDepth: z
      .enum(["basic", "advanced"])
      .default("basic")
      .describe("Search depth mode passed to the search_web capability"),
  }),
  output: z.object({
    swarmId: z
      .string()
      .describe(
        "Unique ID for this research swarm — pass to get_research_status",
      ),
    dispatchId: z
      .string()
      .describe("Subagent fanout dispatch ID from dispatch_subagent"),
    status: z.literal("running"),
    estimatedTasks: z.number().describe("Number of search tasks dispatched"),
  }),
});

export type ResearchSwarmStartInput = z.output<typeof researchSwarmStart.input>;
export type ResearchSwarmStartOutput = z.output<
  typeof researchSwarmStart.output
>;
