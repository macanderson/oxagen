import { z } from "zod";
import { registerCapability } from "../registry";
import { FieldErrorSchema } from "./schema.shared";

export const schemaValidateRelationship = registerCapability({
  name: "validate_schema_relationship",
  domain: "schema",
  description: "Validate a relationship's type and properties against the workspace schema. Returns conformance score and field-level errors.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    type: z.string().min(1),
    startLabel: z.string().min(1),
    endLabel: z.string().min(1),
    properties: z.record(z.string(), z.unknown()),
    versionId: z.string().optional(),
  }),
  output: z.object({
    valid: z.boolean(),
    conformanceScore: z.number().min(0).max(1),
    errors: z.array(FieldErrorSchema),
    missingRequired: z.array(z.string()),
    outcome: z.enum(["accepted", "rejected", "written_below_floor"]),
  }),
});

export type SchemaValidateRelationshipInput = z.output<typeof schemaValidateRelationship.input>;
export type SchemaValidateRelationshipOutput = z.output<typeof schemaValidateRelationship.output>;
