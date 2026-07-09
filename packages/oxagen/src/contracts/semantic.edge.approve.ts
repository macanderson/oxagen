import { z } from "zod";
import { registerCapability } from "../registry";
import { observedAtField, supersedeField } from "../lib/temporal-query";

export const semanticEdgeApprove = registerCapability({
  name: "approve_semantic_edge",
  domain: "semantic",
  description:
    "Approve or reject an inferred semantic edge candidate. Approved edges are materialised as permanent Neo4j relationships typed by the inferred relationship kind itself (e.g. :IMPLEMENTS, :DEPENDS_ON), with inferred/origin properties marking provenance; rejected edges are soft-dismissed with an audit trail.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "graph" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    edgeId: z
      .string()
      .min(1)
      .describe("UUID of the InferredEdge node to act on"),
    decision: z
      .enum(["approve", "reject"])
      .describe("'approve' materialises the edge as permanent; 'reject' dismisses it with audit trail"),
    comment: z
      .string()
      .max(1000)
      .optional()
      .describe("Optional reviewer note attached to the edge for audit purposes"),
    observedAt: observedAtField,
    supersede: supersedeField,
  }),
  output: z.object({
    edgeId: z.string().describe("The InferredEdge id that was acted on"),
    decision: z.enum(["approve", "reject"]),
    /** Present only when decision=approve — the Neo4j relationship element id. */
    permanentEdgeId: z
      .string()
      .optional()
      .describe("Neo4j element-id of the permanent relationship created on approval"),
    superseded: z
      .number()
      .default(0)
      .describe("Count of prior open edges of the same type from the source closed by supersession"),
  }),
});

export type SemanticEdgeApproveInput = z.output<typeof semanticEdgeApprove.input>;
export type SemanticEdgeApproveOutput = z.output<typeof semanticEdgeApprove.output>;
