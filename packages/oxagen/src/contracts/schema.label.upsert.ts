import { z } from "zod";
import { registerCapability } from "../registry";
import { propertyInputSchema } from "./schema.types";

export const schemaLabelUpsert = registerCapability({
  name: "upsert_schema_label",
  domain: "schema",
  description:
    "Create/update a node label on a schema within the draft version.",
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
    name: z
      .string()
      .min(1)
      .max(200)
      .describe("Node label name (e.g. Customer, Contract)"),
    displayName: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    naturalKeyProps: z
      .array(z.string())
      .optional()
      .describe("Property names forming the dedup natural key"),
    properties: z.array(propertyInputSchema).optional(),
  }),
  output: z.object({
    labelId: z.string(),
    created: z.boolean(),
  }),
});

export type SchemaLabelUpsertInput = z.output<typeof schemaLabelUpsert.input>;
export type SchemaLabelUpsertOutput = z.output<typeof schemaLabelUpsert.output>;
