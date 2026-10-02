import { z } from "zod";
import { registerCapability } from "../registry";
import {
  MARKDOWN_IMPORT_ROWS_MAX,
  markdownImportFileCount,
  markdownImportMemorySchema,
  markdownImportPolicySchema,
  markdownImportRecordSchema,
  markdownImportTooManyFiles,
} from "./steering.markdown_import.shared";

/**
 * The commit's fields. The MCP tool lists them, and the contract wraps them in
 * the refinement that holds the PR to STEERING_PR_MAX_FILES files.
 */
export const markdownImportCommitFields = {
  records: z
    .array(markdownImportRecordSchema)
    .max(MARKDOWN_IMPORT_ROWS_MAX)
    .default([])
    .describe("The record rows from parse_markdown_import, as edited"),
  policies: z
    .array(markdownImportPolicySchema)
    .max(MARKDOWN_IMPORT_ROWS_MAX)
    .default([])
    .describe("The policy rows from parse_markdown_import, as edited"),
  memories: z
    .array(markdownImportMemorySchema)
    .max(MARKDOWN_IMPORT_ROWS_MAX)
    .default([])
    .describe("The memory rows from parse_markdown_import, as edited"),
};

/**
 * Why commit left out a memory row marked add. `stored` is a statement an
 * earlier import stored from the same file and line, whose memory has since
 * left the waiting state.
 */
export const markdownImportMemorySkipReasonSchema = z.enum([
  "waiting",
  "rejected",
  "import",
  "stored",
]);

/** One memory row marked add that commit left out, and what it matches. */
export const markdownImportMemorySkipSchema = z
  .object({
    file: z.string(),
    line: z.number().int().min(1),
    reason: markdownImportMemorySkipReasonSchema.describe(
      "waiting, rejected, import for an earlier row of this commit, or stored",
    ),
    memory: z
      .string()
      .nullable()
      .describe("The waiting memory's id (mem_...) for waiting, or null"),
  })
  .strict();

/**
 * commit_markdown_import: the second half of the Markdown import
 * (memory-collection spec, Bulk import; discussions spec, Markdown import).
 *
 * It takes the rows parse_markdown_import returned, as a person edited them.
 * The records and policies marked `add` go into one steering PR on
 * steering/import-<date>: each record as steering/<kind folder>/<lineage>.md
 * (a skill as steering/skills/<lineage>/SKILL.md, a memory record under
 * steering/memory/), with `origin: user` and `provenance.source: import`, and
 * each policy as policy/<file-slug>.cedar. The PR runs the steering checks
 * and reports them as the "Oxagen steering" check. Nothing steers until the
 * PR merges.
 *
 * The memory rows marked `add` are stored as waiting memories with capture
 * `import`, no agent, and no run: a person wrote them, not an agent. A row
 * whose statement a waiting memory holds, or a person rejected, is left out
 * and named. A commit may carry records, policies, and memories
 * at once. One with no record or policy marked add opens no PR.
 *
 * It refuses a row whose force its kind forbids, a constraint with no
 * effect, rows that mark more than STEERING_PR_MAX_FILES (299) records and
 * policies add, a conflict nobody chose for, a policy the early checks
 * failed, and a memory over 2,000 characters marked add.
 */
export const steeringMarkdownImportCommit = registerCapability({
  name: "commit_markdown_import",
  domain: "context",
  description:
    "Open one steering PR on steering/import-<date> with the Markdown import's records and Cedar policies marked add, and store its memories marked add as waiting memories with capture import. Records keep origin: user and provenance.source: import. The PR runs the steering checks, and nothing steers until it merges. A memory that repeats a waiting or rejected one is left out and named.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object(markdownImportCommitFields)
    .strict()
    .superRefine((rows, ctx) => {
      const message = markdownImportTooManyFiles(markdownImportFileCount(rows));
      if (message !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message });
      }
    }),
  output: z
    .object({
      pullRequest: z
        .object({
          number: z.number().int().positive(),
          url: z.string(),
          branch: z.string(),
          /** The commit the "Oxagen steering" check ran on. */
          headSha: z.string(),
        })
        .strict()
        .nullable()
        .describe(
          "The steering PR, or null when no record or policy was marked add",
        ),
      /** Every path the PR adds or replaces, in path order. */
      paths: z.array(z.string()),
      records: z.number().int().nonnegative().describe("Records the PR holds"),
      policies: z
        .number()
        .int()
        .nonnegative()
        .describe("Policy files the PR holds"),
      skipped: z
        .number()
        .int()
        .nonnegative()
        .describe("Rows marked skip, left out of the PR and the memories"),
      memories: z
        .object({
          stored: z
            .number()
            .int()
            .nonnegative()
            .describe("Waiting memories stored with capture import"),
          skipped: z
            .array(markdownImportMemorySkipSchema)
            .describe(
              "Memory rows marked add that were left out, each with what it matches",
            ),
        })
        .strict(),
    })
    .strict(),
});

export type SteeringMarkdownImportCommitInput = z.input<
  typeof steeringMarkdownImportCommit.input
>;
export type SteeringMarkdownImportCommitOutput = z.output<
  typeof steeringMarkdownImportCommit.output
>;
