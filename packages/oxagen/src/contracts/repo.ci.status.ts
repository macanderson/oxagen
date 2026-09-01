import { z } from "zod";
import { registerCapability } from "../registry";

// Shared CI run/status shapes. `repo.pr.get` reuses the `overall`/`counts`/`runs`
// subset (everything except `ref`/`sha`), so they are exported for reuse.
export const ciRunConclusionSchema = z
  .enum([
    "success",
    "failure",
    "neutral",
    "cancelled",
    "timed_out",
    "action_required",
    "skipped",
    "stale",
  ])
  .nullable();

export const ciRunSchema = z.object({
  name: z.string().describe("Check run or status context name"),
  status: z
    .enum(["queued", "in_progress", "completed"])
    .describe("Lifecycle status of the check"),
  conclusion: ciRunConclusionSchema.describe(
    "Terminal conclusion, null while still running",
  ),
  url: z.string().nullable().describe("Details URL for the check, if any"),
  startedAt: z.string().nullable().describe("ISO 8601 start timestamp"),
  completedAt: z.string().nullable().describe("ISO 8601 completion timestamp"),
  durationMs: z
    .number()
    .nullable()
    .describe("Elapsed run time in milliseconds, if computable"),
  app: z
    .string()
    .nullable()
    .describe('Owning app/integration, e.g. "GitHub Actions"'),
});

export const ciCountsSchema = z.object({
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  pending: z.number().int(),
  skipped: z.number().int(),
  neutral: z.number().int(),
});

export const ciOverallSchema = z.enum([
  "passing",
  "failing",
  "pending",
  "neutral",
  "unknown",
]);

export const repoCiStatus = registerCapability({
  name: "get_ci_status",
  domain: "repo",
  description:
    "Read CI check-run and commit-status results for a ref in a GitHub repository.",
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
    ref: z
      .string()
      .describe("Branch name, commit SHA, or PR head ref to read CI for"),
  }),
  output: z.object({
    ref: z.string().describe("The ref that was queried"),
    sha: z.string().nullable().describe("Resolved commit SHA for the ref"),
    overall: ciOverallSchema.describe("Aggregated CI verdict"),
    counts: ciCountsSchema.describe("Tallies across all checks"),
    runs: z.array(ciRunSchema).describe("Every check run and legacy status"),
  }),
});

export type RepoCiStatusInput = z.output<typeof repoCiStatus.input>;
export type RepoCiStatusOutput = z.output<typeof repoCiStatus.output>;
