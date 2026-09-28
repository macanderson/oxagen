/**
 * What a session's memory recall is scoped by (#4458): the tools it called,
 * the files its tools named, and the repository it runs in. The control
 * plane ranks a memory scoped to one of them above the rest, so a prompt
 * gets the memories about the work in front of it.
 *
 * Tool hooks fill the lists, in the same shape from all four harnesses. Each
 * list keeps the most recent entries, each once, and a repeat moves to the
 * front. The repository is read once per session, off the prompt's path,
 * and read again only when the session's `cwd` leaves that repository. The
 * lists live in memory only, and `forgetRecallHints` clears them when the
 * session ends.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RepositoryRemote } from "./git-facts";
import type { MemoryRecallRequest } from "./memory-capture/memory-recall";
import type { RecallHints, RepositoryRead, SessionRecord } from "./registry";

/** How many distinct tool names a session keeps for its recalls. */
export const RECALL_TOOLS_KEPT = 32;

/** How many distinct file paths a session keeps for its recalls. */
export const RECALL_PATHS_KEPT = 64;

/** The longest tool name the recall route takes. */
const TOOL_NAME_MAX_CHARS = 200;

/** The longest file path the recall route takes. */
const PATH_MAX_CHARS = 512;

/** The `tool_input` keys that name a file, in Claude Code's shape. */
const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

/** The part of a session record this module reads and writes. */
export type RecallHintsHolder = Pick<SessionRecord, "cwd" | "recallHints">;

/** Reads the repository a directory is in (`readRepositoryRemote`). */
export type RepositoryReader = (
  cwd: string,
) => Promise<RepositoryRemote | undefined>;

/** The scope of one recall, as `MemoryRecallRequest` takes it. */
export type RecallScope = Pick<
  MemoryRecallRequest,
  "repositoryDigests" | "tools" | "paths"
>;

function hintsOf(record: RecallHintsHolder): RecallHints {
  record.recallHints ??= { tools: [], paths: [] };
  return record.recallHints;
}

/** `list` with `entry` in front, each entry once, cut to `max`. */
function inFront(list: readonly string[], entry: string, max: number) {
  return [entry, ...list.filter((held) => held !== entry)].slice(0, max);
}

/**
 * `path` relative to `root` with `/` separators: empty for the root itself,
 * and undefined for a path outside it.
 */
function relativeTo(root: string, path: string): string | undefined {
  const inside = relative(root, path);
  if (inside === ".." || inside.startsWith(`..${sep}`)) return undefined;
  // On Windows a path on another drive stays absolute.
  if (isAbsolute(inside)) return undefined;
  return inside.split(sep).join("/");
}

/**
 * Note one tool call: its tool's name, and the file its input names under
 * `file_path`, `path`, or `notebook_path`. A relative path is resolved
 * against the session's `cwd`, and is dropped when the `cwd` is not known,
 * because the daemon's own directory says nothing about the session.
 */
export function noteRecallHints(
  record: RecallHintsHolder,
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): void {
  const hints = hintsOf(record);
  if (
    toolName !== undefined &&
    toolName.length > 0 &&
    toolName.length <= TOOL_NAME_MAX_CHARS
  )
    hints.tools = inFront(hints.tools, toolName, RECALL_TOOLS_KEPT);
  for (const key of PATH_KEYS) {
    const value = toolInput?.[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const cwd = record.cwd;
    const absolute = isAbsolute(value)
      ? resolve(value)
      : cwd !== undefined && isAbsolute(cwd)
        ? resolve(cwd, value)
        : undefined;
    if (absolute !== undefined)
      hints.paths = inFront(hints.paths, absolute, RECALL_PATHS_KEPT);
  }
}

/**
 * True when `held` answers for `cwd`: the same directory, or one inside its
 * root.
 */
function covers(held: RepositoryRead, cwd: string): boolean {
  if (held.cwd === cwd) return true;
  const root = held.remote?.root;
  return root !== undefined && relativeTo(root, cwd) !== undefined;
}

/**
 * The read of the session's repository: the one already held when it
 * answers for the session's `cwd`, or a new one started now. Undefined when
 * the `cwd` is not known. The answer never rejects, so a caller may leave it
 * running and read `recallScope` later.
 */
export function readRepository(
  record: RecallHintsHolder,
  read: RepositoryReader,
): Promise<RepositoryRemote | undefined> | undefined {
  const cwd = record.cwd;
  if (cwd === undefined) return undefined;
  const hints = hintsOf(record);
  const held = hints.repository;
  if (held !== undefined && covers(held, cwd)) return held.answer;
  const next: RepositoryRead = {
    cwd,
    settled: false,
    answer: Promise.resolve(undefined),
  };
  // `then` runs the reader after this call returns, so a reader that throws
  // at once settles the answer as undefined too.
  next.answer = Promise.resolve()
    .then(() => read(cwd))
    .then(
      (remote) => remote,
      () => undefined,
    )
    .then((remote) => {
      next.settled = true;
      if (remote !== undefined) next.remote = remote;
      return remote;
    });
  hints.repository = next;
  return next.answer;
}

/**
 * The scope a recall sends now, most recent first. A repository read still
 * running, or one for a directory the session has left, sends no digests
 * and no paths, so the prompt never waits on git. Without a root, a path
 * cannot be named relative to it, so none is sent.
 */
export function recallScope(record: RecallHintsHolder): RecallScope {
  const hints = record.recallHints;
  const held = hints?.repository;
  const remote =
    held?.settled === true &&
    record.cwd !== undefined &&
    covers(held, record.cwd)
      ? held.remote
      : undefined;
  const root = remote?.root;
  const paths: string[] = [];
  if (root !== undefined) {
    for (const path of hints?.paths ?? []) {
      const inside = relativeTo(root, path);
      if (
        inside !== undefined &&
        inside.length > 0 &&
        inside.length <= PATH_MAX_CHARS
      )
        paths.push(inside);
    }
  }
  return {
    repositoryDigests:
      remote === undefined
        ? []
        : [...new Set([remote.remote_digest, remote.remote_digest_folded])],
    tools: [...(hints?.tools ?? [])],
    paths,
  };
}

/**
 * Forget the session's tools, files, and repository. A session that ended
 * keeps its record for days (`forgetSealed`), so the lists are cleared here
 * rather than left to go with it.
 */
export function forgetRecallHints(record: RecallHintsHolder): void {
  delete record.recallHints;
}
