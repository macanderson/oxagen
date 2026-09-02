import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaPropertyDelete = registerCapability({
  name: "delete_schema_property",
  domain: "schema",
  description: "Remove a property from the draft.",
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
    ownerKind: z.enum(["node", "relationship"]),
    ownerName: z.string().min(1),
    key: z.string().min(1),
  }),
  output: z.object({
    deleted: z.boolean(),
    propertyKey: z.string(),
  }),
});

export type SchemaPropertyDeleteInput = z.output<
  typeof schemaPropertyDelete.input
>;
export type SchemaPropertyDeleteOutput = z.output<
  typeof schemaPropertyDelete.output
>;
