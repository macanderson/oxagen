/**
 * `oxagen memory`: the workspace's memories, the lessons agents wrote in
 * their harnesses' own memory stores, which Oxagen collects from enrolled
 * hosts (memory-collection spec; ADR-245).
 *
 *   oxagen memory list [--state s] [--harness h] [--agent a] [--repository r] [--type t] [--limit n] [--offset n] [--json]
 *   oxagen memory show <id> [--json]
 *   oxagen memory promote <ids...> [--one-record] [--statement t] [--kind k] [--force f] [--effect e] [--repo r] [--no-same-text] [--json]
 *   oxagen memory dismiss <ids...> [--restore] [--json]
 *   oxagen memory import <files...> [--yes] [--json]
 *
 * A memory steers only the agent that wrote it, through its harness. It
 * reaches other agents only once a person promotes it into a steering record
 * and the memory PR merges. list, show, promote, and dismiss call
 * list_workspace_memories, get_workspace_memory, promote_memories, and
 * dismiss_memories through lib/workspace-memory-client.
 *
 * `oxagen memory import` reads Markdown files into steering records through
 * parse_markdown_import and commit_markdown_import.
 *
 * The in-app assistant's own memory store in Neo4j has no command here. Its
 * capabilities stay on the API and MCP.
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
import type { MemoryDraftRecord } from "@oxagen/oxagen/contracts/steering.memories.shared";
import { ApiError } from "../lib/api.js";
import {
  parseMarkdownImport,
  commitMarkdownImport,
  formatImportRows,
  formatImportPullRequest,
  MARKDOWN_IMPORT_FILES_PER_CALL,
} from "../lib/memory-client.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import {
  dismissWorkspaceMemories,
  formatDismissResult,
  formatPromoteResult,
  formatWorkspaceMemories,
  formatWorkspaceMemory,
  getWorkspaceMemory,
  listWorkspaceMemories,
  promoteWorkspaceMemories,
  WORKSPACE_MEMORY_STATES,
} from "../lib/workspace-memory-client.js";

/**
 * The capabilities `oxagen memory list|show|promote|dismiss` call, by their
 * registered names, through the routes in lib/workspace-memory-client.
 */
export const MEMORY_COMMAND_CAPABILITIES = [
  "list_workspace_memories",
  "get_workspace_memory",
  "promote_memories",
  "dismiss_memories",
] as const;

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

/** A comma-separated or repeated option, as a list of values. */
function listOpt(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v])
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

const HARNESSES = ["claude-code", "codex", "cursor", "stella", "claude-desktop"];
const KINDS = [
  "business-rule",
  "code-rule",
  "constraint",
  "procedure",
  "fact",
  "preference",
  "memory",
];
const FORCES = ["must", "should", "may", "info"];
const EFFECTS = ["require", "forbid"];

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly string[],
  flag: string,
  writer: CommandWriter,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value))
    fail(`Invalid ${flag} "${value}". Use one of: ${allowed.join(", ")}.`, writer);
  return value as T;
}

export interface MemoryListCliOptions {
  state?: string | string[];
  harness?: string;
  agent?: string;
  repository?: string;
  type?: string;
  limit?: string;
  offset?: string;
  json?: boolean;
}

/**
 * `oxagen memory list`: the workspace's memories ranked by uses, then the
 * newest use, then the newest capture, one row per group of memories that
 * say the same thing. Waiting and in-PR memories unless `--state` names
 * others.
 */
export async function handleMemoryList(
  opts: MemoryListCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const states = listOpt(opts.state);
  for (const state of states)
    oneOf(state, WORKSPACE_MEMORY_STATES, "--state", writer);
  const harness = oneOf<string>(opts.harness, HARNESSES, "--harness", writer);
  try {
    const result = await listWorkspaceMemories({
      states:
        states.length === 0
          ? undefined
          : (states as (typeof WORKSPACE_MEMORY_STATES)[number][]),
      harness,
      agent: opts.agent,
      repository: opts.repository,
      type: opts.type,
      limit: parseIntOpt(opts.limit, "--limit", writer),
      offset: parseIntOpt(opts.offset, "--offset", writer),
    });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatWorkspaceMemories(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

/** `oxagen memory show <id>`: one memory with its source, its uses, and its memory PR. */
export async function handleMemoryShow(
  id: string,
  opts: { json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  try {
    const result = await getWorkspaceMemory(id);
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatWorkspaceMemory(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryPromoteCliOptions {
  /** Cite every id in one record, for memories that say the same thing. */
  oneRecord?: boolean;
  statement?: string;
  kind?: string;
  force?: string;
  effect?: string;
  repo?: string | string[];
  /** Commander sets this false for `--no-same-text`. */
  sameText?: boolean;
  json?: boolean;
}

/**
 * `oxagen memory promote <ids...>`: draft steering records from waiting
 * memories, on the open memory PR or a new one. One record per id, or one
 * record that cites every id with `--one-record`. Each record also cites the
 * waiting memories that say the same thing unless `--no-same-text`.
 */
export async function handleMemoryPromote(
  ids: string[],
  opts: MemoryPromoteCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (ids.length === 0)
    fail("Nothing to promote. Pass one or more memory ids, such as `oxagen memory promote mem_…`.", writer);
  const records = opts.oneRecord ? 1 : ids.length;
  if (opts.statement !== undefined && records > 1)
    fail(
      "--statement sets one record's body. Pass one id, or add --one-record to cite every id in one record.",
      writer,
    );
  const kind = oneOf<NonNullable<MemoryDraftRecord["kind"]>>(opts.kind, KINDS, "--kind", writer);
  const force = oneOf<NonNullable<MemoryDraftRecord["force"]>>(opts.force, FORCES, "--force", writer);
  const effect = oneOf<NonNullable<MemoryDraftRecord["effect"]>>(opts.effect, EFFECTS, "--effect", writer);
  const repos = listOpt(opts.repo);
  const shared: Omit<MemoryDraftRecord, "memory_ids"> = {
    ...(opts.statement === undefined ? {} : { statement: opts.statement }),
    ...(kind === undefined ? {} : { kind }),
    ...(force === undefined ? {} : { force }),
    ...(effect === undefined ? {} : { effect }),
    ...(repos.length === 0 ? {} : { repos }),
  };
  const drafts: MemoryDraftRecord[] = opts.oneRecord
    ? [{ memory_ids: ids, ...shared }]
    : ids.map((id) => ({ memory_ids: [id], ...shared }));
  try {
    const result = await promoteWorkspaceMemories({
      drafts,
      same_text: opts.sameText !== false,
    });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatPromoteResult(result));
  } catch (err) {
    handleApiError(err, writer);
  }
}

export interface MemoryDismissCliOptions {
  restore?: boolean;
  json?: boolean;
}

/**
 * `oxagen memory dismiss <ids...>`: set memories aside, so the curator does
 * not propose their statements again without new evidence. `--restore`
 * brings dismissed memories back.
 */
export async function handleMemoryDismiss(
  ids: string[],
  opts: MemoryDismissCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (ids.length === 0)
    fail("Nothing to dismiss. Pass one or more memory ids, such as `oxagen memory dismiss mem_…`.", writer);
  const restore = opts.restore === true;
  try {
    const result = await dismissWorkspaceMemories({ memory_ids: ids, restore });
    if (opts.json) {
      writer.write(JSON.stringify(result, null, 2));
      return;
    }
    writer.write(formatDismissResult(result, restore));
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
