import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentMemoryWrite = registerCapability({
  name: "agent.memory.write",
  domain: "agent",
  description: "Persist a weighted memory tied to a graph node per the oxagen-feature skill memory contract",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    nodeRef: z.string(),
    weight: z.enum(["low", "high", "critical"]),
    kind: z.enum([
      "routine-change",
      "constraint",
      "bug-root-cause",
      "convention-deviation",
      "gotcha",
    ]),
    lesson: z.string().min(1).max(2000),
    source: z.enum(["feature", "fix", "exception-watcher", "bug-report"]),
  }),
  output: z.object({
    memoryId: z.string(),
    nodeRef: z.string(),
  }),
});

export type AgentMemoryWriteInput = z.output<typeof agentMemoryWrite.input>;
export type AgentMemoryWriteOutput = z.output<typeof agentMemoryWrite.output>;
