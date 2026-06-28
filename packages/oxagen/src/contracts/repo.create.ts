import { z } from "zod";
import { registerCapability } from "../registry";

export const repoCreate = registerCapability({
  name: "repo.create",
  domain: "repo",
  description: "Create a new GitHub repository in an organization the user owns.",
  mode: "sync",
  surfaces: ["agent", "api"],
  layers: ["api", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "high", category: "vcs" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    org: z.string().describe("GitHub organisation slug to create the repository in"),
    name: z.string().describe("Repository name"),
    description: z.string().optional().describe("Short repository description"),
    private: z.boolean().optional().describe("Whether the repository is private (default: false)"),
    autoInit: z.boolean().optional().describe("Initialise the repository with a README (default: false)"),
  }),
  output: z.object({
    fullName: z.string().describe("Owner/repo full name (e.g. myorg/myrepo)"),
    htmlUrl: z.string().describe("HTML URL of the new repository"),
    defaultBranch: z.string().describe("Default branch name"),
  }),
});

export type RepoCreateInput = z.output<typeof repoCreate.input>;
export type RepoCreateOutput = z.output<typeof repoCreate.output>;
