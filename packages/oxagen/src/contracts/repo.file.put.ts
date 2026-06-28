import { z } from "zod";
import { registerCapability } from "../registry";

export const repoFilePut = registerCapability({
  name: "repo.file.put",
  domain: "repo",
  description: "Commit a file (create or update) to a GitHub repository.",
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
    owner: z.string().describe("Repository owner (user or organisation)"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("File path within the repository (e.g. src/index.ts)"),
    content: z.string().describe("Raw UTF-8 file content — base64 encoding is handled internally"),
    message: z.string().describe("Commit message"),
    branch: z.string().optional().describe("Branch to commit to (defaults to the repository default branch)"),
  }),
  output: z.object({
    commitSha: z.string().describe("SHA of the commit that created or updated the file"),
    htmlUrl: z.string().describe("HTML URL of the committed file"),
  }),
});

export type RepoFilePutInput = z.output<typeof repoFilePut.input>;
export type RepoFilePutOutput = z.output<typeof repoFilePut.output>;
