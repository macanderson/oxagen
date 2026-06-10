import { z } from "zod";
import { registerCapability } from "../registry";

export const researchSwarmStatus = registerCapability({
  name: "research.swarm.status",
  domain: "research",
  description:
    "Poll the status of a running research swarm. Returns task completion progress and partial results. Delegates to agent.subagent.aggregate internally.",
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
        }),
      )
      .optional()
      .describe("Per-query result counts when available"),
  }),
});

export type ResearchSwarmStatusInput = z.output<typeof researchSwarmStatus.input>;
export type ResearchSwarmStatusOutput = z.output<typeof researchSwarmStatus.output>;
