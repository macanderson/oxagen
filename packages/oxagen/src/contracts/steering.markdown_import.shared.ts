// steering.markdown_import.shared.ts: the rows the Markdown import passes
// from parse_markdown_import to commit_markdown_import (memory-collection
// spec, Bulk import and Enforcement grade; discussions spec, Markdown
// import). Not a capability: exported through the barrel so the contracts
// file-coverage guard sees it, like context.steering.shared.ts.
//
// Parse returns these rows for a person to review and edit. Commit takes
// them back. Each record row carries the rule both halves enforce: a force
// the record's kind allows (forcesFor), and an effect on a constraint and on
// no other kind. Each memory row is a memory with force info, and one marked
// add fits the 2,000 characters a memory holds.
import { z } from "zod";
import { STEERING_RECORD_LABEL_MAX } from "../steering-record-label";
import { lineageSchema } from "../steering-repo/common";
import { MEMORY_STATEMENT_MAX } from "../steering-repo/memory";
import { STEERING_PR_MAX_FILES } from "../steering-repo/names";
import { recordEffectSchema } from "../steering-repo/record-effect";
import {
  forceAllowed,
  forcesFor,
  recordForceSchema,
} from "../steering-repo/record-force";
import { recordKindSchema } from "../steering-repo/record-kind";

/** The most files one parse call takes. The app and the CLI send larger imports in calls of 25. */
export const MARKDOWN_IMPORT_FILES_MAX = 25;
/** The most characters one file may hold. */
export const MARKDOWN_IMPORT_FILE_CHARS_MAX = 100_000;
/** The most statements the import splits one file into. */
export const MARKDOWN_IMPORT_STATEMENTS_MAX = 50;
/** The most rows one commit takes: 25 files of 50 statements. */
export const MARKDOWN_IMPORT_ROWS_MAX =
  MARKDOWN_IMPORT_FILES_MAX * MARKDOWN_IMPORT_STATEMENTS_MAX;

/**
 * The files a commit of these rows writes: one per record and one per policy
 * marked add. One steering PR holds at most STEERING_PR_MAX_FILES of them.
 */
export function markdownImportFileCount(rows: {
  records: readonly { action: "add" | "skip" | null }[];
  policies: readonly { action: "add" | "skip" }[];
}): number {
  return (
    rows.records.filter((row) => row.action === "add").length +
    rows.policies.filter((policy) => policy.action === "add").length
  );
}

/** Why rows that write `count` files cannot be one steering PR, or null when they can. */
export function markdownImportTooManyFiles(count: number): string | null {
  if (count <= STEERING_PR_MAX_FILES) return null;
  return `The import marks ${count} records and policy files add, and one steering PR holds at most ${STEERING_PR_MAX_FILES} files. Mark ${count - STEERING_PR_MAX_FILES} of them skip, or import the files in smaller sets.`;
}

/** How many files the rows marked add would put in the steering PR, against the limit. */
export const markdownImportPullRequestFilesSchema = z
  .object({
    count: z
      .number()
      .int()
      .nonnegative()
      .describe("Files the rows marked add would put in the steering PR"),
    max: z
      .number()
      .int()
      .positive()
      .describe("The most files one steering PR holds"),
    message: z
      .string()
      .nullable()
      .describe("What to do when the count is over the limit, or null when it fits"),
  })
  .strict();

/**
 * Where a file goes. `records` splits it into steering records, `policies`
 * turns its fenced `cedar` blocks into Cedar policy files, `memories` splits
 * it into statements stored as waiting memories, and `skip` leaves it out.
 */
export const markdownImportTargetSchema = z.enum([
  "records",
  "policies",
  "memories",
  "skip",
]);
export type MarkdownImportTarget = z.output<typeof markdownImportTargetSchema>;

/** One uploaded file, and the target the person chose for it. */
export const markdownImportDocumentSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "The file's name, or its path relative to the folder imported, such as docs/release.md",
      ),
    content: z
      .string()
      .min(1)
      .max(MARKDOWN_IMPORT_FILE_CHARS_MAX)
      .describe("The file's Markdown text"),
    target: markdownImportTargetSchema
      .optional()
      .describe(
        "records, policies, memories, or skip. Omit it to take the target the file's text implies.",
      ),
  })
  .strict();
export type MarkdownImportDocument = z.output<
  typeof markdownImportDocumentSchema
>;

/** A record a statement matches: a published one, or another row of the same import. */
export const markdownImportMatchSchema = z
  .object({
    lineage: z.string().min(1),
    /** Where the matched record lives, or null for a published record with no known path. */
    path: z.string().nullable(),
    /** True for a record already published, false for another row of this import. */
    published: z.boolean(),
  })
  .strict();
export type MarkdownImportMatch = z.output<typeof markdownImportMatchSchema>;

/** A statement may stay a frontmatter record, or come from the split. */
export const markdownImportOriginSchema = z.enum(["frontmatter", "split"]);

/**
 * One steering record the import proposes: a statement the model split out
 * of a file, or a whole file that already carries steering-record/v1
 * frontmatter.
 */
export const markdownImportRecordSchema = z
  .object({
    file: z.string().min(1).max(256).describe("The file the statement came from"),
    line: z
      .number()
      .int()
      .min(1)
      .describe("The line of the file the statement starts on"),
    origin: markdownImportOriginSchema.describe(
      "frontmatter for a file that is one steering record already, split for a statement the model split out",
    ),
    lineage: lineageSchema
      .max(200)
      .describe("The record's lineage, and its file name in the steering repo"),
    label: z
      .string()
      .trim()
      .min(1)
      .max(STEERING_RECORD_LABEL_MAX)
      .describe("The record's name, at most 36 characters"),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(MARKDOWN_IMPORT_FILE_CHARS_MAX)
      .describe("What the record tells an agent: the record's body"),
    kind: recordKindSchema,
    kindReason: z
      .string()
      .max(300)
      .describe("One line on why the statement is this kind"),
    force: recordForceSchema.describe(
      "must, should, may, or info, within the forces the kind allows",
    ),
    forceWords: z
      .string()
      .max(200)
      .describe(
        "The words in the statement that justify the force, or empty when the text gives no signal and the kind's default applies",
      ),
    effect: recordEffectSchema
      .nullable()
      .describe("require or forbid on a constraint, null on every other kind"),
    tokens: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "The statement's size in tokens. A must or should record adds this to every request.",
      ),
    duplicate: markdownImportMatchSchema
      .nullable()
      .describe("The record this statement says again, or null"),
    conflict: markdownImportMatchSchema
      .nullable()
      .describe(
        "The constraint this one contradicts: the same statement with the opposite effect, or null",
      ),
    action: z
      .enum(["add", "skip"])
      .nullable()
      .describe(
        "add or skip. A duplicate defaults to skip. A conflict is null until a person chooses.",
      ),
    frontmatter: z
      .string()
      .max(MARKDOWN_IMPORT_FILE_CHARS_MAX)
      .nullable()
      .describe(
        "The file's frontmatter, kept for a frontmatter record so the commit keeps its other fields. Null for a split statement.",
      ),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (!forceAllowed(row.kind, row.force)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["force"],
        message: `a ${row.kind} carries ${forcesFor(row.kind).join(" or ")}, not ${row.force}`,
      });
    }
    if (row.kind === "constraint" && row.effect === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effect"],
        message: "a constraint declares require or forbid",
      });
    }
    if (row.kind !== "constraint" && row.effect !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effect"],
        message: "only a constraint carries an effect",
      });
    }
    if ((row.origin === "frontmatter") !== (row.frontmatter !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frontmatter"],
        message:
          "a frontmatter record carries its frontmatter, and a split statement carries none",
      });
    }
  });
export type MarkdownImportRecord = z.output<typeof markdownImportRecordSchema>;

/** Why a memory row repeats a statement the workspace already holds. */
export const markdownImportMemoryMatchReasonSchema = z.enum([
  "waiting",
  "rejected",
  "import",
]);

/**
 * What a memory row says again: a waiting memory with the same statement
 * hash, a statement a person rejected (memory_rejections), or an earlier
 * memory row of the same import. A row with a match defaults to skip.
 */
export const markdownImportMemoryMatchSchema = z
  .object({
    reason: markdownImportMemoryMatchReasonSchema.describe(
      "waiting for a waiting memory, rejected for a statement a person rejected, import for an earlier row of this import",
    ),
    memory: z
      .string()
      .nullable()
      .describe("The waiting memory's id (mem_...), or null for any other reason"),
    file: z
      .string()
      .nullable()
      .describe("The file of the earlier row of this import, or null"),
    line: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe("The line of the earlier row of this import, or null"),
  })
  .strict();
export type MarkdownImportMemoryMatch = z.output<
  typeof markdownImportMemoryMatchSchema
>;

/**
 * One memory the import proposes: a statement the model split out of a file
 * imported as memories. Commit stores each row marked add as a waiting
 * memory with capture `import`, no agent, no run, and the source
 * `import:<file>#L<line>`. The memory waits for review like any other, and
 * steers nothing until a person promotes it into a steering record.
 */
export const markdownImportMemorySchema = z
  .object({
    file: z.string().min(1).max(256).describe("The file the statement came from"),
    line: z
      .number()
      .int()
      .min(1)
      .describe("The line of the file the statement starts on"),
    label: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("The memory's name, at most 200 characters"),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(MARKDOWN_IMPORT_FILE_CHARS_MAX)
      .describe(
        `The memory's text. A row marked add holds at most ${MEMORY_STATEMENT_MAX.toLocaleString("en-US")} characters.`,
      ),
    kind: z.literal("memory").describe("Always memory"),
    force: z.literal("info").describe("Always info. A memory carries no other force."),
    duplicate: markdownImportMemoryMatchSchema
      .nullable()
      .describe("The memory or rejected statement this row says again, or null"),
    issue: z
      .string()
      .max(300)
      .nullable()
      .describe("Why the row cannot be stored, such as a statement that is too long, or null"),
    action: z
      .enum(["add", "skip"])
      .describe("add or skip. A row with a match or an issue defaults to skip."),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.action === "add" && row.statement.length > MEMORY_STATEMENT_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["statement"],
        message: `a memory holds at most ${MEMORY_STATEMENT_MAX} characters`,
      });
    }
  });
export type MarkdownImportMemory = z.output<typeof markdownImportMemorySchema>;

/** One Cedar statement in a policy file the import writes. */
export const markdownImportPolicyStatementSchema = z
  .object({
    id: z.string().min(1).describe("The statement's @id"),
    line: z.number().int().min(1).describe("The line of the file it starts on"),
    effect: z.enum(["permit", "forbid"]),
  })
  .strict();

/** A problem the early checks found in a policy, which keeps the file out of the PR. */
export const markdownImportPolicyIssueSchema = z
  .object({
    /** The statement's number in its file, from 1, or null for a problem with a whole block. */
    statement: z.number().int().min(1).nullable(),
    id: z.string().nullable(),
    line: z.number().int().min(1).nullable(),
    message: z.string(),
  })
  .strict();

/** The Cedar policy file one Markdown file becomes. */
export const markdownImportPolicySchema = z
  .object({
    file: z.string().min(1).max(256).describe("The Markdown file the policies came from"),
    path: z
      .string()
      .regex(
        /^policy\/[a-z0-9][a-z0-9-]*\.cedar$/,
        "a policy file is policy/<file-slug>.cedar",
      )
      .describe("Where the policy file goes: policy/<file-slug>.cedar"),
    text: z
      .string()
      .min(1)
      .max(MARKDOWN_IMPORT_FILE_CHARS_MAX * 2)
      .describe(
        "The .cedar file: the prose above each block as a comment, then each statement with its @id",
      ),
    statements: z.array(markdownImportPolicyStatementSchema),
    issues: z
      .array(markdownImportPolicyIssueSchema)
      .describe("What the early checks found. A policy with any issue cannot be added."),
    duplicate: z
      .object({ path: z.string() })
      .strict()
      .nullable()
      .describe("The published policy file with the same statements, or null"),
    replaces: z
      .boolean()
      .describe(
        "True when the steering repo already holds a different file at this path, which the commit replaces",
      ),
    action: z.enum(["add", "skip"]),
  })
  .strict();
export type MarkdownImportPolicy = z.output<typeof markdownImportPolicySchema>;

/** What parse decided for one file. */
export const markdownImportFileSchema = z
  .object({
    filename: z.string(),
    target: markdownImportTargetSchema.describe("The target the file was read with"),
    detected: markdownImportTargetSchema.describe("The target the file's text implies"),
    reason: z.string().describe("Why the file's text implies that target"),
    records: z.number().int().nonnegative(),
    policies: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
    /** Why the file yielded nothing, such as a model error. Null when it was read. */
    error: z.string().nullable(),
  })
  .strict();
export type MarkdownImportFile = z.output<typeof markdownImportFileSchema>;
