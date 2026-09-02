import { z } from "zod";
import { registerCapability } from "../registry";
import { memoryClassEnum, memoryKindSchema } from "./agent.memory.model";

export const agentMemoryWrite = registerCapability({
  name: "write_memory",
  domain: "agent",
  description:
    "Persist a two-axis memory (class + kind) tied to a graph node per the oxagen-feature skill memory contract",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    nodeRef: z.string(),
    memoryClass: memoryClassEnum
      .default("OBSERVATION")
      .describe("Epistemic class; new memories default to OBSERVATION"),
    memoryKind: memoryKindSchema.describe("Content domain of the memory"),
    enforcementScore: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Required when memoryClass is RULE (1-100); ignored for OBSERVATION",
      ),
    lesson: z.string().min(1).max(2000),
    source: z.enum(["feature", "fix", "exception-watcher", "bug-report"]),
    relatedNodeIds: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        "IDs of KnowledgeNode entities this memory is about — creates :ABOUT edges",
      ),
  }),
  output: z.object({
    memoryId: z.string(),
    nodeRef: z.string(),
    edgesCreated: z
      .number()
      .describe("Count of :ABOUT edges created to KnowledgeNode entities"),
  }),
});

export type AgentMemoryWriteInput = z.output<typeof agentMemoryWrite.input>;
export type AgentMemoryWriteOutput = z.output<typeof agentMemoryWrite.output>;
