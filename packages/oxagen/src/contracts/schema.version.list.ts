import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaVersionList = registerCapability({
  name: "list_schema_versions",
  domain: "schema",
  description:
    "List versions (number, label, status, published_at, change_summary).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    limit: z.number().int().min(1).max(100).default(20).optional(),
    offset: z.number().int().min(0).default(0).optional(),
  }),
  output: z.object({
    versions: z.array(
      z.object({
        versionId: z.string(),
        versionNumber: z.number(),
        status: z.enum(["draft", "published"]),
        label: z.string().nullable(),
        changeSummary: z.string().nullable(),
        publishedAt: z.string().nullable(),
        isPinned: z.boolean(),
      }),
    ),
    total: z.number(),
  }),
});

export type SchemaVersionListInput = z.output<typeof schemaVersionList.input>;
export type SchemaVersionListOutput = z.output<typeof schemaVersionList.output>;
