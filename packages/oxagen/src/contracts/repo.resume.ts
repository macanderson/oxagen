import { z } from "zod";
import { registerCapability } from "../registry";

export const repoResume = registerCapability({
  name: "resume_repo",
  domain: "repo",
  description: "Resume automatic syncing for a paused repository connection.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "ingestion" },
  sensitivity: "low",
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
    status: z.literal("active"),
    resumedAt: z.string(),
    nextSyncAt: z.string().nullable(),
  }),
});

export type RepoResumeInput = z.output<typeof repoResume.input>;
export type RepoResumeOutput = z.output<typeof repoResume.output>;
