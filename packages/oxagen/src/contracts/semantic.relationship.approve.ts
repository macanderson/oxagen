import { z } from "zod";
import { registerCapability } from "../registry";

export const semanticRelationshipApprove = registerCapability({
  name: "semantic.relationship.approve",
  domain: "semantic",
  description:
    "Approve or reject an inferred semantic relationship candidate. Approved relationships are materialised as permanent Neo4j relationships typed by the inferred relationship kind itself (e.g. :IMPLEMENTS, :DEPENDS_ON), with inferred/origin properties marking provenance; rejected relationships are soft-dismissed with an audit trail.",
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
  }),
  output: z.object({
    edgeId: z.string().describe("The InferredEdge id that was acted on"),
    decision: z.enum(["approve", "reject"]),
    permanentEdgeId: z
      .string()
      .optional()
      .describe("Neo4j element-id of the permanent relationship created on approval"),
  }),
});

export type SemanticRelationshipApproveInput = z.output<typeof semanticRelationshipApprove.input>;
export type SemanticRelationshipApproveOutput = z.output<typeof semanticRelationshipApprove.output>;
