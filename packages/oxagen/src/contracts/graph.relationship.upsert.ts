import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";

export const graphRelationshipUpsert = registerCapability({
  name: "graph.relationship.upsert",
  domain: "graph",
  description: "MERGE a typed relationship between two KnowledgeNodes. Relationship type must match the RELATIONSHIP_TYPE_PATTERN lexical guard.",
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
    fromNodeId: z.string().describe("publicId of the source KnowledgeNode"),
    toNodeId: z.string().describe("publicId of the target KnowledgeNode"),
    relationshipType: z
      .string()
      .regex(RELATIONSHIP_TYPE_PATTERN)
      .describe("Relationship type — must match [A-Z][A-Z0-9_]{0,62}"),
    properties: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional string key-value metadata"),
  }),
  output: z.object({
    relationshipId: z
      .string()
      .describe("Composite identifier: fromNodeId:relationshipType:toNodeId"),
    created: z.boolean(),
  }),
});

export type GraphRelationshipUpsertInput = z.output<typeof graphRelationshipUpsert.input>;
export type GraphRelationshipUpsertOutput = z.output<typeof graphRelationshipUpsert.output>;
