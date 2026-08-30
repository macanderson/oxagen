import { z } from "zod";
import { registerCapability } from "../registry";
import {
  propertyInputSchema,
  cardinalityEnum,
  relationshipTypeNameSchema,
} from "./schema.types";

export const schemaRelationshipUpsert = registerCapability({
  name: "upsert_schema_relationship",
  domain: "schema",
  description:
    "Create/update a relationship type on a schema within the draft version.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    schemaName: z.string().min(1),
    name: relationshipTypeNameSchema.describe(
      "Relationship type name (e.g. EMPLOYS, SIGNED_CONTRACT)",
    ),
    displayName: z.string().min(1).max(200),
    startLabel: z
      .string()
      .optional()
      .describe("Constraint: start node label (null = any)"),
    endLabel: z
      .string()
      .optional()
      .describe("Constraint: end node label (null = any)"),
    cardinality: cardinalityEnum.optional(),
    description: z.string().max(2000).optional(),
    properties: z.array(propertyInputSchema).optional(),
  }),
  output: z.object({
    relationshipTypeId: z.string(),
    created: z.boolean(),
  }),
});

export type SchemaRelationshipUpsertInput = z.output<
  typeof schemaRelationshipUpsert.input
>;
export type SchemaRelationshipUpsertOutput = z.output<
  typeof schemaRelationshipUpsert.output
>;
