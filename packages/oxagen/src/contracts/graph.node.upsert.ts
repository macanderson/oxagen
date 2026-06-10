import { z } from "zod";
import { registerCapability } from "../registry";

export const graphNodeUpsert = registerCapability({
  name: "graph.node.upsert",
  domain: "graph",
  description: "MERGE a KnowledgeNode in the graph. Creates or updates by externalId, or by a natural key derived from label+displayName+workspaceId.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    label: z.string().min(1).max(100).describe("User-defined node type, e.g. Person, Company, Topic"),
    displayName: z.string().min(1).max(500).describe("Human-readable name for the node"),
    description: z.string().max(2000).optional().describe("Optional description or summary"),
    properties: z.record(z.string(), z.unknown()).optional().describe("Arbitrary key-value metadata"),
    externalId: z.string().max(500).optional().describe("Stable user-supplied identifier for MERGE; if absent, natural key is label+displayName+workspaceId"),
  }),
  output: z.object({
    nodeId: z.string().describe("publicId of the upserted node"),
    created: z.boolean().describe("True if the node was newly created, false if it was updated"),
  }),
});

export type GraphNodeUpsertInput = z.output<typeof graphNodeUpsert.input>;
export type GraphNodeUpsertOutput = z.output<typeof graphNodeUpsert.output>;
