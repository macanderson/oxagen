import { z } from "zod";
import { registerCapability } from "../registry";

export const repoMetrics = registerCapability({
  name: "get_repo_metrics",
  domain: "repo",
  description: "Get sync statistics and metrics for a repository connection.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "ingestion" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    repoId: z.string().describe("Repository connection ID"),
  }),
  output: z.object({
    repoId: z.string(),
    displayName: z.string(),
    status: z.enum(["pending_setup", "active", "paused", "failed"]),
    entityCount: z.number().describe("Total entities ingested from this repo"),
    entityCountByType: z
      .record(z.number())
      .describe("Entity count breakdown by type"),
    lastSyncAt: z
      .string()
      .nullable()
      .describe("ISO timestamp of last successful sync"),
    lastSyncDurationMs: z
      .number()
      .nullable()
      .describe("Duration of last sync in milliseconds"),
    lastErrorAt: z.string().nullable().describe("ISO timestamp of last error"),
    errorMessage: z.string().nullable().describe("Most recent error message"),
    syncIntervalSeconds: z.number().int().positive().nullable(),
    estimatedNextSyncAt: z.string().nullable(),
  }),
});

export type RepoMetricsInput = z.output<typeof repoMetrics.input>;
export type RepoMetricsOutput = z.output<typeof repoMetrics.output>;
