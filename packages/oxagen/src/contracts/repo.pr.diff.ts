import { z } from "zod";
import { registerCapability } from "../registry";

export const prDiffFileStatusSchema = z.enum([
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
]);

export const prDiffFileSchema = z.object({
  path: z.string().describe("Current file path"),
  previousPath: z
    .string()
    .nullable()
    .describe("Prior path for renames/copies, else null"),
  status: prDiffFileStatusSchema.describe("Change status for the file"),
  additions: z.number().int().describe("Added lines in this file"),
  deletions: z.number().int().describe("Deleted lines in this file"),
  patch: z
    .string()
    .nullable()
    .describe("Unified-diff hunk text; null for binary or too-large files"),
  binary: z.boolean().describe("Whether the file is binary"),
});

export const repoPrDiff = registerCapability({
  name: "get_pr_diff",
  domain: "repo",
  description:
    "Read the per-file unified-diff patches for a GitHub pull request.",
  mode: "sync",
  surfaces: ["agent", "api", "mcp"],
  layers: ["api", "mcp", "unit", "docs", "app"],
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
    number: z.number().int().describe("Pull request number"),
  }),
  output: z.object({
    summary: z.string().describe('Human summary, e.g. "12 files, +340 -58"'),
    additions: z.number().int().describe("Total added lines"),
    deletions: z.number().int().describe("Total deleted lines"),
    changedFiles: z.number().int().describe("Number of changed files"),
    files: z.array(prDiffFileSchema).describe("Per-file diff entries"),
  }),
});

export type RepoPrDiffInput = z.output<typeof repoPrDiff.input>;
export type RepoPrDiffOutput = z.output<typeof repoPrDiff.output>;
