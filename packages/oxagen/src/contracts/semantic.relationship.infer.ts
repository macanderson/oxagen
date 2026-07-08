import { z } from "zod";
import { registerCapability } from "../registry";

export const semanticRelationshipInfer = registerCapability({
  name: "infer_semantic_relationships",
  domain: "semantic",
  description:
    "Run LLM inference to discover and link nodes across sources with confidence scores. Triggers an async job; relationships above the confidenceThreshold are auto-accepted, relationships below it are staged for UI review via semantic.relationship.suggest.",
  mode: "async",
  surfaces: ["api", "mcp", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "graph" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    sourceIds: z
      .array(z.string())
      .optional()
      .describe("Restrict inference to nodes from these connector source IDs (optional — omit to consider all sources)"),
    maxEdgesPerNode: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum inferred relationships to emit per node (limits combinatorial explosion, default 10)"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Preview inferred relationships without persisting them to the graph"),
    semanticEdgePrompt: z
      .string()
      .min(1)
      .max(4000)
      .describe("Custom prompt instructing the LLM on how to identify and type relationships between nodes"),
    confidenceThreshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.8)
      .describe("Relationships at or above this score are auto-accepted; relationships below are staged for review (0.0–1.0, default 0.8)"),
  }),
  output: z.object({
    jobId: z
      .string()
      .describe("Background job ID — poll via the job status mechanism or listen for webhook completion"),
    status: z.literal("queued"),
    estimatedNodes: z
      .number()
      .describe("Approximate number of nodes that will be evaluated for relationships"),
    dryRun: z.boolean().describe("Mirrors the dryRun input flag"),
  }),
});

export type SemanticRelationshipInferInput = z.output<typeof semanticRelationshipInfer.input>;
export type SemanticRelationshipInferOutput = z.output<typeof semanticRelationshipInfer.output>;
