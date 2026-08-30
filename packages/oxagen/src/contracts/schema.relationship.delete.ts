import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaRelationshipDelete = registerCapability({
  name: "delete_schema_relationship",
  domain: "schema",
  description: "Remove a relationship type from the draft.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "schema" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    schemaName: z.string().min(1),
    name: z.string().min(1),
  }),
  output: z.object({
    deleted: z.boolean(),
    relationshipTypeName: z.string(),
  }),
});

export type SchemaRelationshipDeleteInput = z.output<
  typeof schemaRelationshipDelete.input
>;
export type SchemaRelationshipDeleteOutput = z.output<
  typeof schemaRelationshipDelete.output
>;
