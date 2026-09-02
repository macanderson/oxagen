import { z } from "zod";
import { registerCapability } from "../registry";
import { dataTypeEnum, constraintsSchema } from "./schema.types";

export const schemaPropertyUpsert = registerCapability({
  name: "upsert_schema_property",
  domain: "schema",
  description:
    "Create/update a property on a node label or relationship type in the draft.",
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
    ownerKind: z
      .enum(["node", "relationship"])
      .describe(
        "Whether the property belongs to a node label or relationship type",
      ),
    ownerName: z
      .string()
      .min(1)
      .describe("The label or relationship type name"),
    key: z.string().min(1).max(200).describe("Property name"),
    dataType: dataTypeEnum,
    required: z.boolean().default(false),
    description: z.string().max(2000).optional(),
    enumValues: z.array(z.string()).optional(),
    itemType: z.string().optional(),
    constraints: constraintsSchema.optional(),
    example: z.string().optional(),
  }),
  output: z.object({
    propertyId: z.string(),
    created: z.boolean(),
  }),
});

export type SchemaPropertyUpsertInput = z.output<
  typeof schemaPropertyUpsert.input
>;
export type SchemaPropertyUpsertOutput = z.output<
  typeof schemaPropertyUpsert.output
>;
