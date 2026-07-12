import { z } from "zod";
import { registerCapability } from "../registry";

export const repoBranchCreate = registerCapability({
  name: "create_branch",
  domain: "repo",
  description:
    "Create a new branch in a GitHub repository, optionally from another branch.",
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
    branch: z
      .string()
      .describe(
        "Name of the new branch to create. Must not be the repository's default branch name (rejected with 403).",
      ),
    fromBranch: z
      .string()
      .optional()
      .describe(
        "Branch to base the new branch on (defaults to the repository default branch)",
      ),
  }),
  output: z.object({
    ref: z
      .string()
      .describe(
        "Full Git ref of the newly created branch (e.g. refs/heads/my-feature)",
      ),
    sha: z.string().describe("SHA that the new branch points to"),
  }),
});

export type RepoBranchCreateInput = z.output<typeof repoBranchCreate.input>;
export type RepoBranchCreateOutput = z.output<typeof repoBranchCreate.output>;
