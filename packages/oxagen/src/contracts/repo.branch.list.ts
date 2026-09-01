import { z } from "zod";
import { registerCapability } from "../registry";

export const repoBranchList = registerCapability({
  name: "list_branches",
  domain: "repo",
  description:
    "List branches in a GitHub repository, including each branch's SHA, protection status, and which one is the repository's default branch.",
  mode: "sync",
  surfaces: ["agent", "api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "vcs" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    owner: z.string().describe("Repository owner (user or organisation)"),
    repo: z.string().describe("Repository name"),
  }),
  output: z.object({
    branches: z
      .array(
        z.object({
          name: z.string().describe("Branch name"),
          sha: z.string().describe("SHA that the branch currently points to"),
          isDefault: z
            .boolean()
            .describe("Whether this is the repository's default branch"),
          protected: z
            .boolean()
            .describe("Whether the branch has protection rules enabled"),
        }),
      )
      .describe(
        "Branches returned by GitHub, up to 300 (3 pages of 100), in GitHub's default order",
      ),
    defaultBranch: z
      .string()
      .nullable()
      .describe(
        "The repository's default branch name, or null if it could not be resolved",
      ),
  }),
});

export type RepoBranchListInput = z.output<typeof repoBranchList.input>;
export type RepoBranchListOutput = z.output<typeof repoBranchList.output>;
