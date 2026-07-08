// @deprecated Use graph.relationship.upsert instead — one-release alias (removed in v2).
//
// The fixed `GRAPH_EDGE_TYPES` enum is GONE (Workspace Schema Registry §3.2):
// customers define their own relationship types in the registry, and Cypher
// safety is enforced by the always-on lexical `RELATIONSHIP_TYPE_PATTERN` guard
// plus the pinned active-vocabulary allow-list. This contract is kept only as a
// one-release deprecation alias so existing `graph.edge.upsert` callers keep
// working; it now mirrors the `graph.relationship.upsert` input shape (a
// regex-validated `relationshipType`) and no longer references any enum.
import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";
import { observedAtField, supersedeField } from "../lib/temporal-query";

export const graphEdgeUpsert = registerCapability({
  name: "upsert_edge",
  aliases: ["graph.edge.upsert"],
  domain: "graph",
  description:
    "DEPRECATED — use graph.relationship.upsert. MERGE a typed relationship between two " +
    "KnowledgeNodes. Relationship type must match the RELATIONSHIP_TYPE_PATTERN lexical guard.",
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
      .describe("Optional string key-value metadata to store on the relationship"),
    observedAt: observedAtField,
    supersede: supersedeField,
  }),
  output: z.object({
    edgeId: z
      .string()
      .describe("Composite identifier: fromNodeId:relationshipType:toNodeId"),
    created: z.boolean().describe("True if the relationship was newly created, false if it existed"),
    superseded: z
      .number()
      .default(0)
      .describe("Count of prior open edges closed by supersession (0 when supersede=false)"),
  }),
});

export type GraphEdgeUpsertInput = z.output<typeof graphEdgeUpsert.input>;
export type GraphEdgeUpsertOutput = z.output<typeof graphEdgeUpsert.output>;

// @deprecated Use graph.relationship.upsert instead — one-release alias (removed in v2)
export { graphRelationshipUpsert } from "./graph.relationship.upsert";
