// STATUS (2026-07-10): this is the LIVE, canonical implementation of graph
// relationship upserts — it has the registered handler (upsert_edge), tests, and
// the app's graph-explorer as a caller. A planned rename to a separate
// `graph.relationship.upsert` (upsert_graph_relationship) capability was never
// given a handler and has been removed; `upsert_edge` is the single
// relationship-upsert capability.
//
// The fixed `GRAPH_EDGE_TYPES` enum is GONE (Workspace Schema Registry §3.2):
// customers define their own relationship types in the registry, and Cypher
// safety is enforced by the always-on lexical `RELATIONSHIP_TYPE_PATTERN` guard
// plus the pinned active-vocabulary allow-list. The `relationshipType` input is a
// regex-validated open-vocabulary string and no longer references any enum.
import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";
import { observedAtField, supersedeField } from "../lib/temporal-query";

// Re-export so handlers (which may import only from `@oxagen/oxagen/contracts/*`,
// the single oxagen subpath exposed to them) can share the one lexical Cypher
// guard. This re-export previously lived on the removed graph.relationship.upsert
// contract; it now lives on the surviving canonical contract.
export { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";

export const graphEdgeUpsert = registerCapability({
  name: "upsert_edge",
  domain: "graph",
  description:
    "MERGE a typed relationship between two KnowledgeNodes. Relationship type must " +
    "match the RELATIONSHIP_TYPE_PATTERN lexical guard.",
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
      .describe(
        "Optional string key-value metadata to store on the relationship",
      ),
    observedAt: observedAtField,
    supersede: supersedeField,
  }),
  output: z.object({
    edgeId: z
      .string()
      .describe("Composite identifier: fromNodeId:relationshipType:toNodeId"),
    created: z
      .boolean()
      .describe(
        "True if the relationship was newly created, false if it existed",
      ),
    superseded: z
      .number()
      .default(0)
      .describe(
        "Count of prior open edges closed by supersession (0 when supersede=false)",
      ),
  }),
});

export type GraphEdgeUpsertInput = z.output<typeof graphEdgeUpsert.input>;
export type GraphEdgeUpsertOutput = z.output<typeof graphEdgeUpsert.output>;
