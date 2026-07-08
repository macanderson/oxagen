import { z } from "zod";
import { registerCapability } from "../registry";
import { semanticEdgeSchema } from "./semantic.edge.list";

export const semanticRelationshipSuggest = registerCapability({
  name: "suggest_semantic_relationships",
  aliases: ["semantic.relationship.suggest"],
  domain: "semantic",
  description:
    "Returns inferred semantic relationships that are pending human review (below the auto-accept confidence threshold). Intended for the approval flow UI — relationships returned here are read-only candidates until a workspace member approves or dismisses them.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    confidenceMin: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Lower bound on confidence (inclusive). Use to skip very low-confidence noise."),
    confidenceMax: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Upper bound on confidence (inclusive). Typically set to the workspace auto-accept threshold."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(250)
      .default(50)
      .describe("Maximum suggestions to return (1–250, default 50)"),
  }),
  output: z.object({
    suggestions: z.array(semanticEdgeSchema).describe("Unapproved relationship candidates sorted by confidence descending"),
    total: z.number().describe("Total unapproved relationships matching the confidence filter"),
    limit: z.number(),
  }),
});

export type SemanticRelationshipSuggestInput = z.output<typeof semanticRelationshipSuggest.input>;
export type SemanticRelationshipSuggestOutput = z.output<typeof semanticRelationshipSuggest.output>;
