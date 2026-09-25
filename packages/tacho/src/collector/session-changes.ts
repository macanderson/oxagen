/**
 * Which of a worktree's changes one session made.
 *
 * `git-facts.ts` reads what a worktree holds. This module decides which of
 * it belongs to the session reading it, by the rule ADR-186 records: the
 * files the session's own commits touched, and the uncommitted changes it
 * made, without the commits a pull brought in or the edits a person left
 * there before the session started.
 *
 * The rules of `git-facts.ts` hold here too. Nothing throws, nothing is
 * unbounded, and a read that fails returns undefined rather than an empty
 * list. The few reads that go to the filesystem instead of git, the size,
 * times, and hash of a file that was dirty before a session started, use
 * `node:fs/promises` and a stream, so a large file costs time and not
 * memory, and the daemon's event loop is never blocked on one.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExecAsync } from "../host/service";
import {
  absoluteIn,
  countUntracked,
  EMPTY_TREE_OBJECT,
  firstLine,
  type GitWorkingTreeChange,
  git,
  MAX_CHANGED_PATHS,
  parseNameStatusZ,
  parseNumstat,
  parsePorcelainZ,
  pooled,
  provenUnborn,
  readWorkingTreeChanges,
  rowsOf,
  UNTRACKED_COUNT_CONCURRENCY,
} from "./git-facts";

/**
 * The most paths one record of a worktree's earlier edits holds.
 *
 * The record is persisted with the session in the daemon's state file, which
 * is rewritten on every tick that changed anything, so it is bounded. A
 * dirty path past the bound is not recorded, so it cannot be left out, and
 * a reconciliation reports it as the session's. `PreexistingPaths.complete`
 * says when that happened, and the frame carries it.
 */
export const MAX_PREEXISTING_PATHS = 256;

/**
 * The largest file that record hashes the content of. A larger one is
 * recorded by size and modification time, so any change to either reads as
 * a change to the file.
 */
export const MAX_HASHED_FILE_BYTES = 16 * 1024 * 1024;

/** The most commits one session keeps counted as its own in one worktree. */
export const MAX_SESSION_COMMITS = 128;

/**
 * One path that was dirty before the session touched it: the first 32 hex
 * digits of its sha256 (empty for a file past `MAX_HASHED_FILE_BYTES`), its
 * size, and its modification time. `PreexistingPaths` holds null instead
 * for a path that was already deleted.
 */
export type PreexistingEntry = [hash: string, size: number, mtimeMs: number];

/**
 * The uncommitted state of a worktree when a session first read it: what a
 * person left there, which the session did not do.
 */
export interface PreexistingPaths {
  /** Repo-relative path to what it held. */
  paths: Record<string, PreexistingEntry | null>;
  /** False when a bound cut the record short. */
  complete: boolean;
}

/** What one session has established about one worktree. */
export interface WorktreeAttribution {
  /** The commit `HEAD` named at the session's first read of this worktree. */
  baseline?: string;
  /**
   * When the session first read any worktree, in epoch ms. Undefined for a
   * session restored from a state file written before this was kept, which
   * is measured the old way (see `readSessionChanges`).
   */
  firstReadAt?: number;
  /** Commits an earlier read counted as the session's own. */
  ownCommits?: readonly string[];
  /** The worktree's uncommitted state at the session's first read of it. */
  preexisting?: PreexistingPaths;
}

/** One reconciliation's answer, and what the next one starts from. */
export interface SessionChanges {
  changes: GitWorkingTreeChange[];
  /** Every commit counted as the session's, oldest first. */
  ownCommits: string[];
  /**
   * `session`: the rule in `readSessionChanges`. `baseline`: every change
   * since the baseline commit, pulled commits and earlier edits included.
   */
  basis: "session" | "baseline";
  /**
   * On the `session` basis, whether changes that were already in the
   * worktree were left out: `complete`, `partial` (the record hit its
   * bound), or `none` (no record was taken for this worktree).
   */
  preexisting: "complete" | "partial" | "none";
}

/** A full commit name, sha-1 or sha-256. */
const COMMIT_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "-z",
  // Default `normal` mode collapses a new directory into one `?? dir/` entry.
  // `all` names each file (see `readWorkingTreeChanges`).
  "--untracked-files=all",
];

/** A path's size and times, or "absent" when nothing is there. */
async function statOf(absolutePath: string): Promise<
  | {
      size: number;
      mtimeMs: number;
      changedAtMs: number;
      kind: "file" | "link";
    }
  | "absent"
  | undefined
> {
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() && !info.isSymbolicLink()) return undefined;
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      changedAtMs: Math.max(info.mtimeMs, info.ctimeMs),
      kind: info.isFile() ? "file" : "link",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : undefined;
  }
}

/** When a directory last gained or lost an entry, or undefined. */
async function directoryChangedAt(path: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    return info.isDirectory()
      ? Math.max(info.mtimeMs, info.ctimeMs)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first 32 hex digits of the sha256 of a file's bytes, or of a link's
 * target. Read as a stream, so a large file costs time and not memory.
 * Undefined when the read fails.
 */
async function contentHash(
  absolutePath: string,
  kind: "file" | "link",
): Promise<string | undefined> {
  try {
    const hash = createHash("sha256");
    if (kind === "link") hash.update(await readlink(absolutePath));
    else
      for await (const chunk of createReadStream(absolutePath))
        hash.update(chunk as Buffer);
    return hash.digest("hex").slice(0, 32);
  } catch {
    return undefined;
  }
}

/** Whether a porcelain v1 code says the path is gone from the worktree. */
function deletedIn(code: string): boolean {
  return code[1] === "D" || (code[0] === "D" && code[1] === " ");
}

/**
 * Record what a worktree already held uncommitted when a session first read
 * it, so a later reconciliation can leave it out.
 *
 * A dirty path is recorded only when nothing has touched it since the
 * session started (`startedAtMs`): its modification and change times, or
 * for a deleted path its directory's, are older. That is what makes the
 * record safe to take late. The first read of a worktree can come after
 * the session's first edit in it: a hook moves the session to another
 * worktree when a tool writes a file there, and the read runs on a later
 * tick, after the write. Without the time check, that edit would be
 * recorded as already there and never reported.
 *
 * Undefined when the status read fails. A path that cannot be measured is
 * not recorded, so it is reported, which is the direction of error a
 * record of what the session did can explain.
 */
export async function readPreexistingPaths(
  exec: ExecAsync,
  root: string,
  startedAtMs: number,
): Promise<PreexistingPaths | undefined> {
  const status = await git(exec, root, STATUS_ARGS);
  if (status === undefined) return undefined;
  const listed = parsePorcelainZ(status).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const paths: Record<string, PreexistingEntry | null> = {};
  await pooled(
    listed.slice(0, MAX_PREEXISTING_PATHS).map((entry) => async () => {
      const absolute = absoluteIn(root, entry.path);
      const found = await statOf(absolute);
      if (found === undefined) return;
      if (found === "absent") {
        // Listed as present and now gone is a race with a writer, not a
        // deletion that predates the session.
        if (!deletedIn(entry.code)) return;
        const parent = await directoryChangedAt(dirname(absolute));
        if (parent === undefined || parent >= startedAtMs) return;
        paths[entry.path] = null;
        return;
      }
      if (found.changedAtMs >= startedAtMs) return;
      const hash =
        found.kind === "file" && found.size > MAX_HASHED_FILE_BYTES
          ? ""
          : await contentHash(absolute, found.kind);
      if (hash === undefined) return;
      paths[entry.path] = [hash, found.size, found.mtimeMs];
    }),
    UNTRACKED_COUNT_CONCURRENCY,
  );
  return {
    paths,
    complete:
      listed.length <= MAX_PREEXISTING_PATHS &&
      listed.length < MAX_CHANGED_PATHS,
  };
}

/** Whether a recorded path still holds what it held at the session's first read. */
async function unchangedSince(
  root: string,
  repoRelative: string,
  entry: PreexistingEntry | null,
): Promise<boolean> {
  const absolute = absoluteIn(root, repoRelative);
  const found = await statOf(absolute);
  if (entry === null) return found === "absent";
  if (found === undefined || found === "absent") return false;
  const [hash, size, mtimeMs] = entry;
  if (found.size === size && found.mtimeMs === mtimeMs) return true;
  if (hash === "" || found.size > MAX_HASHED_FILE_BYTES) return false;
  return (await contentHash(absolute, found.kind)) === hash;
}

/**
 * The email git stamps on a commit made in this repository: the configured
 * `user.email`, or failing that the identity git would derive for itself.
 * Lowercased, because an email's domain is not case sensitive and git
 * copies the configured spelling as written.
 */
async function committerEmail(
  exec: ExecAsync,
  cwd: string,
): Promise<string | undefined> {
  const configured = firstLine(await git(exec, cwd, ["config", "user.email"]));
  if (configured !== undefined) return configured.toLowerCase();
  const ident = firstLine(await git(exec, cwd, ["var", "GIT_COMMITTER_IDENT"]));
  const email = ident === undefined ? undefined : /<([^>]*)>/.exec(ident)?.[1];
  return email === undefined || email.length === 0
    ? undefined
    : email.toLowerCase();
}

/** One diff of the worktree against `ref`: which paths differ, and by how much. */
async function diffAgainst(
  exec: ExecAsync,
  cwd: string,
  ref: string,
): Promise<
  | {
      entries: { code: string; path: string }[];
      counts: Map<string, { added: number; removed: number }>;
    }
  | undefined
> {
  const [names, numstat] = await Promise.all([
    git(exec, cwd, ["diff", "--name-status", "-z", ref]),
    git(exec, cwd, ["diff", "--numstat", ref, "-z"]),
  ]);
  if (names === undefined || numstat === undefined) return undefined;
  return { entries: parseNameStatusZ(names), counts: parseNumstat(numstat) };
}

/**
 * The commits in `baseline..head` this session made, appended to the ones an
 * earlier read already counted, oldest first. Undefined when the range
 * cannot be read.
 */
async function sessionCommits(
  exec: ExecAsync,
  cwd: string,
  baseline: string,
  head: string,
  firstReadAt: number,
  known: readonly string[],
): Promise<string[] | undefined> {
  const own = [...known];
  if (head === baseline) return own;
  const range = await git(exec, cwd, [
    "log",
    "--no-merges",
    "-z",
    "--format=%H %ct %ce",
    `${baseline}..${head}`,
    "--",
  ]);
  if (range === undefined) return undefined;
  const email = await committerEmail(exec, cwd);
  // Committer dates are whole seconds. A commit made in the same second as
  // the first read counts.
  const since = Math.floor(firstReadAt / 1000);
  // `git log` lists newest first. Reversed, so the list stays oldest first.
  const oldestFirst = range.split("\0").reverse();
  for (const record of oldestFirst) {
    const [sha, seconds, ...rest] = record.trim().split(" ");
    if (sha === undefined || sha.length === 0 || seconds === undefined)
      continue;
    if (email === undefined || rest.join(" ").toLowerCase() !== email) continue;
    if (!(Number(seconds) >= since) || own.includes(sha)) continue;
    own.push(sha);
  }
  return own.slice(-MAX_SESSION_COMMITS);
}

/**
 * The files these commits touched, and the commits git still has. A commit
 * a garbage collection removed is dropped rather than failing the read.
 */
async function filesOfCommits(
  exec: ExecAsync,
  cwd: string,
  commits: readonly string[],
): Promise<{ paths: Set<string>; present: Set<string> } | undefined> {
  const paths = new Set<string>();
  const present = new Set<string>();
  if (commits.length === 0) return { paths, present };
  const shown = await git(exec, cwd, [
    "log",
    "--no-walk=unsorted",
    "--ignore-missing",
    "--no-renames",
    "--name-only",
    "-z",
    "--format=%x01%H",
    ...commits,
    "--",
  ]);
  if (shown === undefined) return undefined;
  // Each commit is `\x01<sha>\0`, then its paths after a newline, each
  // ending in NUL. A commit that touched nothing has no paths.
  for (const chunk of shown.split("\x01")) {
    const [sha, ...rest] = chunk.split("\0");
    if (sha === undefined || sha.trim().length === 0) continue;
    present.add(sha.trim());
    for (const field of rest) {
      const path = field.replace(/^\n/, "");
      if (path.length > 0) paths.add(path);
    }
  }
  return { paths, present };
}

/**
 * What this session changed in one worktree, with line counts.
 *
 * The rule, recorded in ADR-186. A path is reported when either:
 *
 * - a commit the session made touched it. The session's commits are the
 *   non-merge commits in `baseline..HEAD` whose committer email is the one
 *   this repository stamps (`committerEmail`) and whose committer date is at
 *   or after the session's first git read, together with every commit an
 *   earlier read already counted. Its status and counts come from the
 *   worktree against the baseline, which covers the committed and the
 *   uncommitted work on it; or
 * - the worktree differs from `HEAD` there, tracked or untracked, and the
 *   path is not one the worktree already held that way at the session's
 *   first read (`readPreexistingPaths`) with its content unchanged since.
 *   Its status and counts come from the worktree against `HEAD`.
 *
 * So a pull, a fetch and reset to upstream, or a rebase onto upstream adds
 * no upstream file: those commits carry someone else's committer email, or
 * a date before the session. The session's own rebased commits still count,
 * because a rebase stamps them with the session's email and the time it
 * ran. And a commit counted once stays counted, so work a squash merge
 * brought back through a pull is still reported, measured against the
 * baseline. A person's uncommitted edit that was there first is left out
 * until its content changes.
 *
 * The ADR names what the rule cannot tell apart: a commit made in this
 * repository by anything else using the same email after the session's
 * first read (another session in a sibling worktree, a person at the
 * keyboard, a `cherry-pick`), and an upstream path the session also
 * touched, whose counts include the upstream change.
 *
 * A session restored from a state file older than the first-read time is
 * measured the old way, every change since the baseline commit, and says
 * so in `basis`. Undefined, as everywhere in this file, is a read that did
 * not happen; nothing here turns a failed read into a clean worktree.
 */
export async function readSessionChanges(
  exec: ExecAsync,
  cwd: string,
  start: WorktreeAttribution,
): Promise<SessionChanges | undefined> {
  if (start.firstReadAt === undefined) {
    const changes = await readWorkingTreeChanges(exec, cwd, start.baseline);
    return changes === undefined
      ? undefined
      : {
          changes,
          ownCommits: [...(start.ownCommits ?? [])],
          basis: "baseline",
          preexisting: "none",
        };
  }
  const status = await git(exec, cwd, STATUS_ARGS);
  if (status === undefined) return undefined;
  const listed = parsePorcelainZ(status);
  const [headLine, root] = await Promise.all([
    git(exec, cwd, ["rev-parse", "HEAD"]).then(firstLine),
    git(exec, cwd, ["rev-parse", "--show-toplevel"]).then(firstLine),
  ]);
  const head =
    headLine !== undefined && COMMIT_NAME.test(headLine) ? headLine : undefined;
  // Both come back from the state file, and both end up as git arguments,
  // so anything that is not a commit name is dropped rather than passed on.
  const baseline =
    start.baseline !== undefined && COMMIT_NAME.test(start.baseline)
      ? start.baseline
      : undefined;
  let own = (Array.isArray(start.ownCommits) ? start.ownCommits : []).filter(
    (sha): sha is string => typeof sha === "string" && COMMIT_NAME.test(sha),
  );
  if (baseline !== undefined && head !== undefined) {
    const counted = await sessionCommits(
      exec,
      cwd,
      baseline,
      head,
      start.firstReadAt,
      own,
    );
    if (counted === undefined) return undefined;
    own = counted;
  }
  const touched = await filesOfCommits(exec, cwd, own);
  if (touched === undefined) return undefined;
  own = own.filter((sha) => touched.present.has(sha));
  const headRef =
    head ?? ((await provenUnborn(exec, cwd)) ? EMPTY_TREE_OBJECT : undefined);
  if (headRef === undefined) return undefined;
  const fromBaseline =
    baseline !== undefined && baseline !== head && touched.paths.size > 0;
  const [atHead, atBaseline] = await Promise.all([
    diffAgainst(exec, cwd, headRef),
    fromBaseline ? diffAgainst(exec, cwd, baseline) : undefined,
  ]);
  if (atHead === undefined || (fromBaseline && atBaseline === undefined))
    return undefined;

  const rows = new Map<string, string>();
  const counts = new Map<string, { added: number; removed: number }>();
  for (const entry of atBaseline?.entries ?? []) {
    if (!touched.paths.has(entry.path)) continue;
    rows.set(entry.path, entry.code);
    const count = atBaseline?.counts.get(entry.path);
    if (count !== undefined) counts.set(entry.path, count);
  }
  for (const entry of atHead.entries) {
    if (rows.has(entry.path)) continue;
    rows.set(entry.path, entry.code);
    const count = atHead.counts.get(entry.path);
    if (count !== undefined) counts.set(entry.path, count);
  }
  for (const entry of listed)
    if (entry.code === "??" && !rows.has(entry.path))
      rows.set(entry.path, entry.code);

  // Left out: what the worktree held before the session, still unchanged. A
  // path the session committed is its own whatever it held before.
  const preexisting =
    typeof start.preexisting?.paths === "object" &&
    start.preexisting.paths !== null
      ? start.preexisting
      : undefined;
  if (preexisting !== undefined && root !== undefined) {
    const recorded = [...rows.keys()].filter(
      (path) =>
        !touched.paths.has(path) && Object.hasOwn(preexisting.paths, path),
    );
    await pooled(
      recorded.map((path) => async () => {
        if (await unchangedSince(root, path, preexisting.paths[path] ?? null))
          rows.delete(path);
      }),
      UNTRACKED_COUNT_CONCURRENCY,
    );
  }

  const entries = [...rows].map(([path, code]) => ({ code, path }));
  if (root !== undefined)
    await countUntracked(exec, cwd, root, entries, counts);
  return {
    changes: rowsOf(entries, counts, root),
    ownCommits: own,
    basis: "session",
    preexisting:
      preexisting === undefined
        ? "none"
        : preexisting.complete
          ? "complete"
          : "partial",
  };
}
