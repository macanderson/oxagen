import { z } from "zod";
import { registerCapability } from "../registry";

export const repoConfigure = registerCapability({
  name: "configure_repo",
  domain: "repo",
  description:
    "Set repo-specific filters, sync cadence, and field mappings. Specializes connection.configure for code repository connectors.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "ingestion",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    repoId: z.string().describe("Repository connection ID (UUID or public ID)"),
    recordTypes: z
      .array(z.string())
      .optional()
      .describe("Record types to ingest (e.g., pull_request, issue, commit)"),
    pathFilters: z
      .object({
        include: z.array(z.string()).optional().describe("Paths to include"),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Paths to exclude (e.g., node_modules, dist)"),
      })
      .optional()
      .describe("Path-based filtering"),
    labelFilters: z
      .object({
        include: z.array(z.string()).optional().describe("Labels to include"),
        exclude: z.array(z.string()).optional().describe("Labels to exclude"),
      })
      .optional()
      .describe("Label-based filtering for issues and PRs"),
    syncCadence: z
      .enum(["manual", "polling", "webhook"])
      .optional()
      .describe("Sync trigger method"),
    pollingIntervalSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Polling interval in seconds (if syncCadence=polling)"),
    fieldMappings: z
      .record(z.string())
      .optional()
      .describe(
        "Custom field mappings (source field path → canonical property)",
      ),
  }),
  output: z.object({
    repoId: z.string(),
    displayName: z.string(),
    recordTypes: z.array(z.string()),
    pathFilters: z
      .object({
        include: z.array(z.string()),
        exclude: z.array(z.string()),
      })
      .nullable(),
    labelFilters: z
      .object({
        include: z.array(z.string()),
        exclude: z.array(z.string()),
      })
      .nullable(),
    syncCadence: z.enum(["manual", "polling", "webhook"]),
    pollingIntervalSeconds: z.number().int().positive().nullable(),
    updatedAt: z.string(),
  }),
});

export type RepoConfigureInput = z.output<typeof repoConfigure.input>;
export type RepoConfigureOutput = z.output<typeof repoConfigure.output>;
