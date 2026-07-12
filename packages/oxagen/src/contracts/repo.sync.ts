import { z } from "zod";
import { registerCapability } from "../registry";

export const repoSync = registerCapability({
  name: "sync_repo",
  domain: "repo",
  description:
    "Trigger incremental or full re-index of a repository connection.",
  mode: "async",
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
    repoId: z.string().describe("Repository connection ID"),
    mode: z
      .enum(["incremental", "full"])
      .default("incremental")
      .describe(
        "Sync mode: incremental (since last cursor) or full (from scratch)",
      ),
    recordTypes: z
      .array(z.string())
      .optional()
      .describe("Restrict sync to these record types"),
  }),
  output: z.object({
    jobId: z.string().describe("Background sync job ID"),
    status: z.literal("queued"),
    mode: z.enum(["incremental", "full"]),
    estimatedRecords: z
      .number()
      .describe("Estimated number of records to process"),
  }),
});

export type RepoSyncInput = z.output<typeof repoSync.input>;
export type RepoSyncOutput = z.output<typeof repoSync.output>;
