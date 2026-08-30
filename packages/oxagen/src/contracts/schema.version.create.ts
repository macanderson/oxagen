import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaVersionCreate = registerCapability({
  name: "create_schema_version",
  domain: "schema",
  description:
    "Freeze the current draft into an immutable published version and open a fresh draft.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    label: z
      .string()
      .max(200)
      .optional()
      .describe("Human tag, e.g. Sales CRM v2"),
    changeSummary: z.string().max(2000).optional(),
  }),
  output: z.object({
    versionId: z.string(),
    versionNumber: z.number().int(),
    publishedAt: z.string(),
  }),
});

export type SchemaVersionCreateInput = z.output<
  typeof schemaVersionCreate.input
>;
export type SchemaVersionCreateOutput = z.output<
  typeof schemaVersionCreate.output
>;
