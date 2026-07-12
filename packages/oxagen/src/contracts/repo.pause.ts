import { z } from "zod";
import { registerCapability } from "../registry";

export const repoPause = registerCapability({
  name: "pause_repo",
  domain: "repo",
  description: "Pause automatic syncing for a repository connection.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
    status: z.literal("paused"),
    pausedAt: z.string(),
  }),
});

export type RepoPauseInput = z.output<typeof repoPause.input>;
export type RepoPauseOutput = z.output<typeof repoPause.output>;
