import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaExport = registerCapability({
  name: "export_schema",
  domain: "schema",
  description:
    "Build a ZIP of a version (grouped by schema) via the create_archive plumbing; returns access-controlled serveUrl.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
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
    versionId: z
      .string()
      .optional()
      .describe("Version to export; defaults to pinned version"),
  }),
  output: z.object({
    assetId: z.string(),
    serveUrl: z.string().describe("Access-controlled URL to download the ZIP"),
    versionId: z.string(),
    versionNumber: z.number(),
  }),
});

export type SchemaExportInput = z.output<typeof schemaExport.input>;
export type SchemaExportOutput = z.output<typeof schemaExport.output>;
