import { z } from "zod";
import { registerCapability } from "../registry";
import {
  MARKDOWN_IMPORT_FILES_MAX,
  markdownImportDocumentSchema,
  markdownImportFileSchema,
  markdownImportPolicySchema,
  markdownImportPullRequestFilesSchema,
  markdownImportRecordSchema,
} from "./steering.markdown_import.shared";

/**
 * parse_markdown_import: the first half of the Markdown import
 * (memory-collection spec, Bulk import; discussions spec, Markdown import).
 *
 * It reads up to 25 Markdown files and returns the grid a person reviews:
 *
 * - A file with steering-record/v1 frontmatter stays one record.
 * - Any other file under the `records` target is split by one model call
 *   into at most 50 statements. Each statement gets one of the eight record
 *   kinds with a one-line reason, the line it starts on, a force within the
 *   forces its kind allows with the words that justify it, and an effect when
 *   it is a constraint.
 * - A file under the `policies` target becomes one Cedar policy file from its
 *   fenced `cedar` blocks, with an @id on every statement and the early shape
 *   checks.
 * - Each statement is checked against the published records and the import's
 *   other statements with the steering check's conflicts test. A duplicate
 *   defaults to skip and names the record it matches. A conflict waits for a
 *   person's choice.
 * - `pullRequestFiles` counts the rows marked add against the 299 files one
 *   steering PR holds, and says what to do when the import is over.
 *
 * It writes nothing. commit_markdown_import takes the rows back.
 */
export const steeringMarkdownImportParse = registerCapability({
  name: "parse_markdown_import",
  domain: "context",
  description:
    "Read up to 25 Markdown files and propose steering records and Cedar policies from them. Each statement gets a kind with a reason, a force its kind allows with the words that justify it, an effect when it is a constraint, its source line, and any duplicate or conflict with a published record or another statement. Writes nothing.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      documents: z
        .array(markdownImportDocumentSchema)
        .min(1)
        .max(MARKDOWN_IMPORT_FILES_MAX)
        .describe("The Markdown files to read, at most 25 per call"),
    })
    .strict(),
  output: z
    .object({
      files: z
        .array(markdownImportFileSchema)
        .describe("One entry per file, in the order sent"),
      records: z
        .array(markdownImportRecordSchema)
        .describe("The steering records proposed, file by file in source order"),
      policies: z
        .array(markdownImportPolicySchema)
        .describe("The Cedar policy files proposed, one per file"),
      pullRequestFiles: markdownImportPullRequestFilesSchema.describe(
        "The files the rows marked add would put in one steering PR, and a message when that is more than one PR holds",
      ),
    })
    .strict(),
});

export type SteeringMarkdownImportParseInput = z.input<
  typeof steeringMarkdownImportParse.input
>;
export type SteeringMarkdownImportParseOutput = z.output<
  typeof steeringMarkdownImportParse.output
>;
