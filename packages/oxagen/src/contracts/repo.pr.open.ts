import { z } from "zod";
import { registerCapability } from "../registry";

export const repoPrOpen = registerCapability({
  name: "open_pr",
  domain: "repo",
  description: "Open a pull request in a GitHub repository.",
  mode: "sync",
  surfaces: ["agent", "api", "mcp"],
  layers: ["api", "mcp", "unit", "docs"],
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
    title: z.string().describe("Pull request title"),
    head: z.string().describe("Branch containing the changes (e.g. feature/my-branch). Must differ from base."),
    base: z.string().describe("Branch the PR is targeting (e.g. main)"),
    body: z.string().optional().describe("Pull request description body (Markdown)"),
    draft: z.boolean().optional().describe("Open as a draft pull request"),
  }),
  output: z.object({
    number: z.number().int().describe("Pull request number"),
    htmlUrl: z.string().describe("HTML URL of the pull request"),
  }),
});

export type RepoPrOpenInput = z.output<typeof repoPrOpen.input>;
export type RepoPrOpenOutput = z.output<typeof repoPrOpen.output>;
