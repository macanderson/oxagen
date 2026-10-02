import { z } from "zod";
import { registerCapability } from "../registry";
import {
  MARKDOWN_IMPORT_ROWS_MAX,
  markdownImportFileCount,
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
};

/**
 * commit_markdown_import: the second half of the Markdown import
 * (memory-collection spec, Bulk import; discussions spec, Markdown import).
 *
 * It takes the rows parse_markdown_import returned, as a person edited them,
 * and opens one steering PR on steering/import-<date> that holds every row
 * marked `add`: each record as steering/<kind folder>/<lineage>.md (a skill as
 * steering/skills/<lineage>/SKILL.md, a memory under steering/memory/), with
 * `origin: user` and `provenance.source: import`, and each policy as
 * policy/<file-slug>.cedar. The PR runs the steering checks and reports them
 * as the "Oxagen steering" check. Nothing steers until the PR merges.
 *
 * It refuses a row whose force its kind forbids, a constraint with no
 * effect, rows that mark more than STEERING_PR_MAX_FILES (299) records and
 * policies add, a conflict nobody chose for, and a policy the early checks
 * failed.
 */
export const steeringMarkdownImportCommit = registerCapability({
  name: "commit_markdown_import",
  domain: "context",
  description:
    "Open one steering PR on steering/import-<date> with the Markdown import's records and Cedar policies marked add. Records keep origin: user and provenance.source: import. The PR runs the steering checks, and nothing steers until it merges.",
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
        .strict(),
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
        .describe("Rows marked skip, left out of the PR"),
    })
    .strict(),
});

export type SteeringMarkdownImportCommitInput = z.input<
  typeof steeringMarkdownImportCommit.input
>;
export type SteeringMarkdownImportCommitOutput = z.output<
  typeof steeringMarkdownImportCommit.output
>;
