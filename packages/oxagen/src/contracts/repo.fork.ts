import { z } from "zod";
import { registerCapability } from "../registry";

export const repoFork = registerCapability({
  name: "fork_repo",
  domain: "repo",
  description:
    "Fork a GitHub repository into the authenticated user's account or a specified organization.",
  mode: "sync",
  surfaces: ["agent", "api", "mcp"],
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "high", category: "vcs" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    owner: z.string().describe("Repository owner (user or organisation)"),
    repo: z.string().describe("Repository name"),
    intoOrg: z
      .string()
      .optional()
      .describe(
        "Fork into this organisation instead of the authenticated user's personal account",
      ),
  }),
  output: z.object({
    fullName: z.string().describe("Owner/repo full name of the fork"),
    htmlUrl: z.string().describe("HTML URL of the fork"),
    defaultBranch: z.string().describe("Default branch name of the fork"),
  }),
});

export type RepoForkInput = z.output<typeof repoFork.input>;
export type RepoForkOutput = z.output<typeof repoFork.output>;
