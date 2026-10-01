/**
 * `oxagen memory` + `oxagen remember` — manage the workspace's agent memories
 * from the shell.
 *
 *   oxagen memory list [--class OBSERVATION|RULE|FACT] [--kind k] [--min-enforcement n] [--min-citations n] [--sort createdAt|citations] [--json]
 *   oxagen memory show <id> [--json]
 *   oxagen memory edit <id> [--lesson t] [--kind k] [--source s]
 *   oxagen memory salience <id> [--confidence n] [--enforcement n] [--status s]
 *   oxagen memory promote <id> --to rule|fact [--enforcement n] [--rationale "…"]
 *   oxagen memory demote <id> --to rule|observation [--enforcement n] [--rationale "…"]
 *   oxagen memory dismiss <id> [--restore]
 *   oxagen memory candidates [--limit n]
 *   oxagen memory citations [--days n] [--limit n]
 *   oxagen memory rm <id>
 *   oxagen memory import <files...> [--yes] [--json]
 *   oxagen remember <text...> [--class c] [--kind k] [--enforcement n] [--node ref]
 *
 * Every command delegates to lib/memory-client (the shared transport +
 * formatters the REPL slash commands also use) and exits non-zero with a
 * friendly message on an API/auth error.
 */
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import {
  markdownImportFileCount,
  markdownImportTooManyFiles,
  type MarkdownImportRecord,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { STEERING_PR_MAX_FILES } from "@oxagen/oxagen/steering-repo/names";
import { markImportMatches, type ImportMatchRow } from "@oxagen/steering-check";
import { ApiError } from "../lib/api.js";
import {
  listMemories,
  rememberMemory,
  updateMemory,
  deleteMemory,
  promoteMemory,
  demoteMemory,
  dismissPromotion,
  citationStats,
  promotionCandidates,
  parseMarkdownImport,
  commitMarkdownImport,
  formatMemoryLines,
  formatMemoryDetail,
  formatRememberResult,
  formatPromoteResult,
  formatDemoteResult,
  formatDismissResult,
  formatCitationStats,
  formatPromotionCandidates,
  formatImportRows,
  formatImportPullRequest,
  MARKDOWN_IMPORT_FILES_PER_CALL,
  RECOMMENDED_MEMORY_KINDS,
  MEMORY_CLASSES,
  type MemoryClass,
  type MemoryStatus,
} from "../lib/memory-client.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

/**
 * Print an error and diverge — exit(1) for the one-shot `oxagen memory …` CLI
 * contract, or throw for the REPL's inline capture-execution seam (any
 * `writer` other than the real stdout means we're running inside the
 * Ink-mounted REPL, where `process.exit` would tear down the whole session).
 * The message is already written to `writer` before either path is taken, so
 * the REPL bridge's catch-all can just use the accumulated captured output.
 */
function fail(message: string, writer: CommandWriter = stdoutWriter): never {
  writer.writeErr(message);
  if (writer === stdoutWriter) process.exit(1);
  throw new Error(message);
}

// memoryKind is an open string per the two-axis model: it is passed through
// unvalidated. RECOMMENDED_MEMORY_KINDS exists only to hint the flag's help
// text — it is deliberately not an allow-list.

function parseClass(
  v: string | undefined,
  writer: CommandWriter,
): MemoryClass | undefined {
  if (v === undefined) return undefined;
  const upper = v.toUpperCase();
  if (!MEMORY_CLASSES.includes(upper as MemoryClass)) {
    fail(
      `Invalid class "${v}". Use one of: ${MEMORY_CLASSES.join(", ")}.`,
      writer,
    );
  }
  return upper as MemoryClass;
}

function parseStatus(
  v: string | undefined,
  writer: CommandWriter,
): MemoryStatus | undefined {
  if (v === undefined) return undefined;
  const upper = v.toUpperCase();
  const STATUSES = ["ACTIVE", "SUPERSEDED", "RETRACTED", "ARCHIVED"];
  if (!STATUSES.includes(upper)) {
    fail(`Invalid status "${v}". Use one of: ${STATUSES.join(", ")}.`, writer);
  }
  return upper as MemoryStatus;
}

function parseIntOpt(
  v: string | undefined,
  label: string,
  writer: CommandWriter,
): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) fail(`Invalid ${label} "${v}". Use an integer.`, writer);
  return n;
}

function handleApiError(err: unknown, writer: CommandWriter): never {
  if (err instanceof ApiError) fail(err.message, writer);
  fail(err instanceof Error ? err.message : String(err), writer);
}

function parseSort(
  v: string | undefined,
  writer: CommandWriter,
): "createdAt" | "citationCount" | undefined {
  if (v === undefined) return undefined;
  if (v === "createdAt" || v === "citations" || v === "citationCount") {
    return v === "citations" ? "citationCount" : v;
  }
  fail(`Invalid --sort "${v}". Use "createdAt" or "citations".`, writer);
}

export interface MemoryListCliOptions {
  class?: string;
  kind?: string;
  minEnforcement?: string;
  minCitations?: string;
  sort?: string;
  node?: string;
  limit?: string;
  offset?: string;
  json?: boolean;
}

export async function handleMemoryList(
  opts: MemoryListCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  try {
    const result = await listMemories({
      memoryClass: parseClass(opts.class, writer),
      memoryKind: opts.kind,
      minEnforcement: parseIntOpt(
        opts.minEnforcement,
        "--min-enforcement",
        writer,
      ),
      minCitations: parseIntOpt(opts.minCitations, "--min-citations", writer),
      sort: parseSort(opts.sort, writer),
      nodeRef: opts.node,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
    });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatMemoryLines(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export async function handleMemoryShow(
  idOrPublicId: string,
  opts: { json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  try {
    // No get-by-id capability exists; fetch a page and resolve client-side by
    // full id or publicId (or an unambiguous short-id prefix).
    const { memories } = await listMemories({ limit: 200 });
    const match =
      memories.find(
        (m) => m.id === idOrPublicId || m.publicId === idOrPublicId,
      ) ?? memories.find((m) => m.id.startsWith(idOrPublicId));
    if (!match) {
      fail(
        `No memory matching "${idOrPublicId}" in this workspace (searched the latest 200).`,
        writer,
      );
    }
    if (opts.json) {
      writer.write(JSON.stringify(match, null, 2));
      return;
    }
    writer.write(formatMemoryDetail(match));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryEditCliOptions {
  lesson?: string;
  kind?: string;
  source?: string;
  json?: boolean;
}

export async function handleMemoryEdit(
  id: string,
  opts: MemoryEditCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (!opts.lesson && !opts.kind && !opts.source) {
    fail(
      "Nothing to edit. Pass at least one of --lesson, --kind, or --source.",
      writer,
    );
  }
  try {
    const updated = await updateMemory({
      memoryId: id,
      lesson: opts.lesson,
      memoryKind: opts.kind,
      source: opts.source,
    });
    if (opts.json) {
      writer.write(JSON.stringify(updated, null, 2));
      return;
    }
    writer.write(
      `✓ Updated memory ${updated.id}.\n${formatMemoryDetail(updated)}`,
    );
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemorySalienceCliOptions {
  confidence?: string;
  enforcement?: string;
  status?: string;
  json?: boolean;
}

/**
 * `oxagen memory salience <id>` — adjust a memory's confidence/enforcement
 * scores or lifecycle status. Class changes go through `oxagen memory promote`
 * (the only path that can move a memory up the confidence ladder).
 */
export async function handleMemorySalience(
  id: string,
  opts: MemorySalienceCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (!opts.confidence && !opts.enforcement && !opts.status) {
    fail(
      "Nothing to update. Pass at least one of --confidence, --enforcement, or --status.",
      writer,
    );
  }
  let confidenceScore: number | undefined;
  if (opts.confidence !== undefined) {
    confidenceScore = Number(opts.confidence);
    if (
      Number.isNaN(confidenceScore) ||
      confidenceScore < 0 ||
      confidenceScore > 100
    ) {
      fail(
        `Invalid --confidence "${opts.confidence}". Use a number between 0 and 100.`,
        writer,
      );
    }
  }
  let enforcementScore: number | undefined;
  if (opts.enforcement !== undefined) {
    enforcementScore = Number(opts.enforcement);
    if (
      !Number.isInteger(enforcementScore) ||
      enforcementScore < 1 ||
      enforcementScore > 100
    ) {
      fail(
        `Invalid --enforcement "${opts.enforcement}". Use an integer between 1 and 100.`,
        writer,
      );
    }
  }
  const status = parseStatus(opts.status, writer);
  try {
    const updated = await updateMemory({
      memoryId: id,
      confidenceScore,
      enforcementScore,
      status,
    });
    if (opts.json) {
      writer.write(JSON.stringify(updated, null, 2));
      return;
    }
    writer.write(
      `✓ Salience updated — class ${updated.memoryClass}, confidence ${updated.confidenceScore.toFixed(1)}, enforcement ${updated.enforcementScore ?? "—"} (${updated.id}).`,
    );
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryPromoteCliOptions {
  to?: string;
  enforcement?: string;
  rationale?: string;
  json?: boolean;
}

/**
 * `oxagen memory promote <id> --to rule|fact [--rationale "…"]` — move a memory
 * up the confidence ladder, recording an auditable :Promotion event. FACT
 * requires human confirmation server-side, which this CLI invocation provides.
 * The rationale is optional.
 */
export async function handleMemoryPromote(
  id: string,
  opts: MemoryPromoteCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (!opts.to) fail("Missing --to. Use `--to rule` or `--to fact`.", writer);
  const toClass = opts.to.toUpperCase();
  if (toClass !== "RULE" && toClass !== "FACT") {
    fail(`Invalid --to "${opts.to}". Use "rule" or "fact".`, writer);
  }
  let enforcementScore: number | undefined;
  if (opts.enforcement !== undefined) {
    enforcementScore = Number(opts.enforcement);
    if (
      !Number.isInteger(enforcementScore) ||
      enforcementScore < 1 ||
      enforcementScore > 100
    ) {
      fail(
        `Invalid --enforcement "${opts.enforcement}". Use an integer between 1 and 100.`,
        writer,
      );
    }
  }
  try {
    const updated = await promoteMemory({
      memoryId: id,
      toClass,
      enforcementScore,
      rationale: opts.rationale,
    });
    if (opts.json) {
      writer.write(JSON.stringify(updated, null, 2));
      return;
    }
    writer.write(formatPromoteResult(updated));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryDemoteCliOptions {
  to?: string;
  enforcement?: string;
  rationale?: string;
  json?: boolean;
}

/**
 * `oxagen memory demote <id> --to rule|observation [--enforcement n] [--rationale "…"]`
 * — move a memory down the confidence ladder, recording an auditable :Demotion
 * event. Demoting to OBSERVATION clears enforcement; the server rejects a
 * non-downward target.
 */
export async function handleMemoryDemote(
  id: string,
  opts: MemoryDemoteCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (!opts.to)
    fail("Missing --to. Use `--to rule` or `--to observation`.", writer);
  const toClass = opts.to.toUpperCase();
  if (toClass !== "RULE" && toClass !== "OBSERVATION") {
    fail(`Invalid --to "${opts.to}". Use "rule" or "observation".`, writer);
  }
  let enforcementScore: number | undefined;
  if (opts.enforcement !== undefined) {
    enforcementScore = Number(opts.enforcement);
    if (
      !Number.isInteger(enforcementScore) ||
      enforcementScore < 1 ||
      enforcementScore > 100
    ) {
      fail(
        `Invalid --enforcement "${opts.enforcement}". Use an integer between 1 and 100.`,
        writer,
      );
    }
  }
  try {
    const updated = await demoteMemory({
      memoryId: id,
      toClass,
      enforcementScore,
      rationale: opts.rationale,
    });
    if (opts.json) {
      writer.write(JSON.stringify(updated, null, 2));
      return;
    }
    writer.write(formatDemoteResult(updated));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryDismissCliOptions {
  restore?: boolean;
  json?: boolean;
}

/**
 * `oxagen memory dismiss <id> [--restore]` — drop a memory out of the promotion
 * candidate queue (or restore it) without archiving the memory.
 */
export async function handleMemoryDismiss(
  id: string,
  opts: MemoryDismissCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  try {
    const result = await dismissPromotion({
      memoryId: id,
      restore: opts.restore,
    });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatDismissResult(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryCitationsCliOptions {
  days?: string;
  limit?: string;
  json?: boolean;
}

/**
 * `oxagen memory citations [--days n] [--limit n]` — workspace-wide citation
 * analytics: totals, influence/compliance breakdowns, and the most-cited /
 * least-useful / most-violated memories plus most-cited graph nodes.
 */
export async function handleMemoryCitations(
  opts: MemoryCitationsCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  try {
    const result = await citationStats({
      days: parseIntOpt(opts.days, "--days", writer),
      limit: parseIntOpt(opts.limit, "--limit", writer),
    });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatCitationStats(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryCandidatesCliOptions {
  limit?: string;
  json?: boolean;
}

/** `oxagen memory candidates` — the OBSERVATIONs most ready to promote. */
export async function handleMemoryCandidates(
  opts: MemoryCandidatesCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  try {
    const result = await promotionCandidates({
      limit: parseIntOpt(opts.limit, "--limit", writer),
    });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatPromotionCandidates(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export async function handleMemoryRemove(
  id: string,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  try {
    const { deleted } = await deleteMemory(id);
    if (deleted) {
      writer.write(`✓ Deleted memory ${id}.`);
    } else {
      fail(`No memory ${id} found in this workspace.`, writer);
    }
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryImportCliOptions {
  /** Open the steering PR. Without it, the command only previews the records. */
  yes?: boolean;
  json?: boolean;
}

/**
 * The capabilities `oxagen memory import` calls, by their registered names:
 * parse_markdown_import, then commit_markdown_import on --yes.
 */
export const MEMORY_IMPORT_CAPABILITIES = [
  "parse_markdown_import",
  "commit_markdown_import",
] as const;

/**
 * The rows of several parse calls, with the duplicates and conflicts between
 * calls marked. A row keeps every mark its own call gave it. A row newly
 * marked a duplicate is skipped, and one newly marked a conflict waits for a
 * choice, as parse marks them.
 */
export function reconcileImportRows(
  records: readonly MarkdownImportRecord[],
): MarkdownImportRecord[] {
  const rows: ImportMatchRow[] = records.map((row) => ({
    lineage: row.lineage,
    kind: row.kind,
    effect: row.effect,
    statement: row.statement,
    path: null,
    duplicate: row.duplicate,
    conflict: row.conflict,
  }));
  markImportMatches(rows, []);
  return records.map((row, index): MarkdownImportRecord => {
    const marked = rows[index] as ImportMatchRow;
    if (marked.duplicate === row.duplicate && marked.conflict === row.conflict) return row;
    return {
      ...row,
      duplicate: marked.duplicate,
      conflict: marked.conflict,
      action: marked.conflict ? null : marked.duplicate ? "skip" : row.action,
    };
  });
}

/** The name a file is sent under: its path from here, or its base name when it lies outside. */
function importFilename(path: string): string {
  const rel = relative(process.cwd(), path).split(sep).join("/");
  const name = rel === "" || rel.startsWith("..") || isAbsolute(rel) ? basename(path) : rel;
  return name.length > 256 ? basename(path).slice(-256) : name;
}

/**
 * `oxagen memory import <files...>`: read Markdown files into steering
 * records (parse_markdown_import, target records). Each statement gets a kind,
 * a force with the words that justify it, its source line, and any duplicate
 * or conflict with a published record.
 *
 * A bare call previews the records and writes nothing. --yes opens one
 * steering PR with every row marked add (commit_markdown_import). A row that
 * conflicts with a published record needs a person's choice, and the CLI has
 * no editor, so --yes leaves each one out and names it. Files go in calls of
 * 25, and one pass over every call's rows marks the duplicates and conflicts
 * between calls. An import that marks more than 299 records add does not fit
 * one steering PR, so --yes refuses it.
 */
export async function handleMemoryImport(
  files: string[],
  opts: MemoryImportCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (files.length === 0) {
    fail(
      "Nothing to import. Pass one or more Markdown files, such as `oxagen memory import CLAUDE.md`.",
      writer,
    );
  }

  // Read every file, and report the ones that cannot be read rather than stop.
  const documents: { filename: string; content: string; target: "records" }[] = [];
  const unreadable: string[] = [];
  for (const path of files) {
    try {
      const content = await readFile(path, "utf8");
      if (content.trim().length === 0) {
        unreadable.push(`${path} (empty)`);
        continue;
      }
      documents.push({ filename: importFilename(path), content, target: "records" });
    } catch {
      unreadable.push(path);
    }
  }
  if (unreadable.length > 0) {
    writer.writeErr(`Skipped files that are empty or unreadable:\n  ${unreadable.join("\n  ")}`);
  }
  if (documents.length === 0) {
    fail("No readable, non-empty files to import.", writer);
  }

  try {
    const parsedRows: MarkdownImportRecord[] = [];
    const read: { filename: string; error: string | null }[] = [];
    for (let i = 0; i < documents.length; i += MARKDOWN_IMPORT_FILES_PER_CALL) {
      const parsed = await parseMarkdownImport(
        documents.slice(i, i + MARKDOWN_IMPORT_FILES_PER_CALL),
      );
      parsedRows.push(...parsed.records);
      read.push(...parsed.files);
    }
    // Each call compared only its own files. One pass over every call's rows
    // marks a duplicate or a conflict between files sent in different calls.
    const records = reconcileImportRows(parsedRows);
    const count = markdownImportFileCount({ records, policies: [] });
    const tooMany = markdownImportTooManyFiles(count);

    if (!opts.yes) {
      if (opts.json) {
        writer.write(
          JSON.stringify(
            {
              files: read,
              records,
              pullRequestFiles: { count, max: STEERING_PR_MAX_FILES, message: tooMany },
            },
            null,
            2,
          ),
        );
        return;
      }
      writer.write(formatImportRows(records));
      for (const file of read) {
        if (file.error) writer.writeErr(`  ${file.filename}: ${file.error}`);
      }
      if (tooMany !== null) {
        writer.writeErr(`  ${tooMany}`);
      } else if (records.length > 0) {
        writer.write("\nRun again with --yes to open the steering PR.");
      }
      return;
    }

    const conflicts = records.filter((row) => row.action === null);
    for (const row of conflicts) {
      writer.writeErr(
        `  Left out ${row.file}:${row.line} (${row.lineage}): it conflicts with ${row.conflict?.lineage ?? "a published record"}.`,
      );
    }
    const decided = records.map((row) =>
      row.action === null ? { ...row, action: "skip" as const } : row,
    );
    if (!decided.some((row) => row.action === "add")) {
      fail("No record is marked add, so there is no steering PR to open.", writer);
    }
    if (tooMany !== null) fail(tooMany, writer);

    const result = await commitMarkdownImport({ records: decided });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatImportPullRequest(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface RememberCliOptions {
  class?: string;
  kind?: string;
  enforcement?: string;
  node?: string;
  json?: boolean;
}

export async function handleRemember(
  text: string,
  opts: RememberCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed)
    fail(
      'Nothing to remember. Pass the memory text, e.g. `oxagen remember "…"`.',
      writer,
    );
  let enforcementScore: number | undefined;
  if (opts.enforcement !== undefined) {
    enforcementScore = Number(opts.enforcement);
    if (
      !Number.isInteger(enforcementScore) ||
      enforcementScore < 1 ||
      enforcementScore > 100
    ) {
      fail(
        `Invalid --enforcement "${opts.enforcement}". Use an integer between 1 and 100.`,
        writer,
      );
    }
  }
  try {
    // source is omitted so the server defaults it to "user" for a human capture.
    const result = await rememberMemory({
      text: trimmed,
      memoryClass: parseClass(opts.class, writer),
      memoryKind: opts.kind,
      enforcementScore,
      nodeRef: opts.node,
    });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatRememberResult(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

// Re-exported for command registration help text (e.g. `--kind <k>` hints).
export { RECOMMENDED_MEMORY_KINDS };
