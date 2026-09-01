import { z } from "zod";
import { registerCapability } from "../registry";
import { ciOverallSchema, ciCountsSchema, ciRunSchema } from "./repo.ci.status";

// A single PR comment (issue comment or inline review comment), capped and
// normalised into one shape.
export const prCommentSchema = z.object({
  id: z.string().describe("Comment id (stringified GitHub id)"),
  author: z.string().nullable().describe("Comment author login"),
  authorAvatarUrl: z.string().nullable().describe("Author avatar URL"),
  body: z.string().describe("Comment body (Markdown)"),
  createdAt: z.string().describe("ISO 8601 creation timestamp"),
  url: z.string().nullable().describe("HTML URL of the comment"),
  kind: z
    .enum(["issue", "review"])
    .describe("issue = conversation comment, review = inline code comment"),
  path: z
    .string()
    .nullable()
    .describe("File path for review comments, null for issue comments"),
});

export const repoPrGet = registerCapability({
  name: "get_pr",
  domain: "repo",
  description:
    "Read a GitHub pull request's summary, diff stats, comments, and CI status.",
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
    number: z.number().int().describe("Pull request number"),
    title: z.string().describe("Pull request title"),
    url: z.string().describe("HTML URL of the pull request"),
    state: z
      .enum(["open", "closed", "merged"])
      .describe("Effective state (merged distinguished from closed)"),
    draft: z.boolean().describe("Whether the PR is a draft"),
    author: z.string().nullable().describe("PR author login"),
    authorAvatarUrl: z.string().nullable().describe("PR author avatar URL"),
    createdAt: z.string().describe("ISO 8601 creation timestamp"),
    updatedAt: z.string().describe("ISO 8601 last-updated timestamp"),
    body: z.string().nullable().describe("PR description body (Markdown)"),
    baseRef: z.string().describe("Base branch the PR targets"),
    headRef: z.string().describe("Head branch containing the changes"),
    headSha: z.string().nullable().describe("Head commit SHA"),
    additions: z.number().int().describe("Total added lines"),
    deletions: z.number().int().describe("Total deleted lines"),
    changedFiles: z.number().int().describe("Number of changed files"),
    commits: z.number().int().describe("Number of commits"),
    commentCount: z
      .number()
      .int()
      .describe("Total issue comments (true count from GitHub)"),
    reviewCommentCount: z
      .number()
      .int()
      .describe("Total inline review comments (true count from GitHub)"),
    comments: z
      .array(prCommentSchema)
      .describe("Capped list actually fetched (<= 50), newest first"),
    ci: z
      .object({
        overall: ciOverallSchema,
        counts: ciCountsSchema,
        runs: z.array(ciRunSchema),
      })
      .describe("CI status for the PR head (CiStatus without ref/sha)"),
  }),
});

export type RepoPrGetInput = z.output<typeof repoPrGet.input>;
export type RepoPrGetOutput = z.output<typeof repoPrGet.output>;
