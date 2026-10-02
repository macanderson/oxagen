/**
 * `oxagen memory`: the workspace's memories, the lessons agents wrote in
 * their harnesses' own memory stores, which Oxagen collects from enrolled
 * hosts (memory-collection spec; ADR-248).
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
 * parse_markdown_import and commit_markdown_import, with the code
 * `oxagen steering import` shares in lib/markdown-import.
 *
 * The in-app assistant's own memory store in Neo4j has no command here. Its
 * capabilities stay on the API and MCP.
 */
import type { MemoryDraftRecord } from "@oxagen/oxagen/contracts/steering.memories.shared";
import { ApiError } from "../lib/api.js";
import {
  stdoutWriter,
  failCommand as fail,
  type CommandWriter,
} from "../lib/capture-writer.js";
import { readImportDocuments, runMarkdownImport } from "../lib/markdown-import.js";
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
 * `oxagen memory import <files...>`: read Markdown files into steering
 * records (parse_markdown_import, target records). Each statement gets a kind,
 * a force with the words that justify it, its source line, and any duplicate
 * or conflict with a published record.
 *
 * A bare call previews the records and writes nothing. --yes opens one
 * steering PR with every row marked add (commit_markdown_import). The
 * batching, the matching between calls, the preview, and the commit live in
 * lib/markdown-import, which `oxagen steering import` shares.
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
  const documents = await readImportDocuments(
    files.map((path) => ({ path })),
    "records",
    writer,
  );
  await runMarkdownImport(
    documents,
    { policies: false, yes: opts.yes, json: opts.json },
    writer,
  );
}
