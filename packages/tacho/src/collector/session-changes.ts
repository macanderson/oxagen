/**
 * Which of a worktree's changes one session made.
 *
 * `git-facts.ts` reads what a worktree holds. This module decides which of
 * it belongs to the session reading it, by the rule ADR-188 records: the
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
 *
 * The one write is a copy of such a file, into a directory the caller names
 * in Tacho's own state directory, never into the repository or its `.git`.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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

/**
 * The most bytes of copies one session keeps, across every worktree it reads.
 *
 * A file that held uncommitted edits at the session's first read is copied
 * into Tacho's state directory, so that once the session changes it a
 * reconciliation counts only the session's lines rather than everything the
 * file holds against `HEAD`. A file that would pass this bound is not
 * copied. Its row then counts the whole file against `HEAD`, and the frame
 * says so (`SessionChanges.preSessionCounts`).
 */
export const MAX_PRE_SESSION_COPY_BYTES = 8 * 1024 * 1024;

/**
 * The most commits one session carries from one read of a worktree to the
 * next. A commit still in `baseline..HEAD` is found again on every read, so
 * the bound matters only for commits that left that range, such as the
 * session's branch after a squash merge was pulled back.
 */
export const MAX_SESSION_COMMITS = 128;

/**
 * The most commits one read lists from `baseline..HEAD` as the session's.
 * Git filters by committer and stops at this count, so a long range costs a
 * bounded read.
 */
export const MAX_RANGE_COMMITS = 1_024;

/**
 * The most `HEAD` reflog entries one read walks, newest first, for the
 * commits made in the worktree (`madeHere`). A session moves `HEAD` once per
 * commit, checkout, pull, or reset, so this covers far more than one turn.
 */
export const MAX_REFLOG_ENTRIES = 1_024;

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

/**
 * What each reported path was measured against, so the patch beside a
 * reconciliation takes each hunk against the same state its row's line
 * counts came from (ADR-188 decision 5).
 */
export interface MeasuredPaths {
  /**
   * The commit `fromHead` was measured against: `HEAD` at the read, or git's
   * empty tree in a repository with no commit yet.
   */
  headRef: string;
  /** Paths the session's commits touched, measured against the baseline commit. */
  fromBaseline: string[];
  /** Paths measured against `headRef`, or against nothing when untracked. */
  fromHead: string[];
  /**
   * Paths that held uncommitted edits at the session's first read, measured
   * against what they held then: the copy at `copy`, or nothing when the
   * path was absent then.
   */
  fromPreSession: { path: string; copy: string | null }[];
}

/**
 * Where a session keeps its copies (`MAX_PRE_SESSION_COPY_BYTES`): a
 * directory of its own under Tacho's state directory, and how many bytes the
 * session may keep there.
 */
export interface PreSessionCopies {
  dir: string;
  capBytes: number;
}

/** One reconciliation's answer, and what the next one starts from. */
export interface SessionChanges {
  changes: GitWorkingTreeChange[];
  /** On the `session` basis, what each path in `changes` was measured against. */
  measured?: MeasuredPaths;
  /**
   * The commits the next read starts from, oldest first: the newest
   * `MAX_SESSION_COMMITS` of those counted as the session's.
   */
  ownCommits: string[];
  /**
   * `session`: the rule in `readSessionChanges`. `baseline`: every change
   * since the baseline commit, pulled commits and earlier edits included,
   * for a session restored from an older state file or a read the rule
   * could not make.
   */
  basis: "session" | "baseline";
  /**
   * On the `session` basis, whether changes that were already in the
   * worktree were left out: `complete`, `partial` (the record hit its
   * bound, or an entry in it could not be used), or `none` (no record was
   * taken for this worktree).
   */
  preexisting: "complete" | "partial" | "none";
  /**
   * How the rows of paths that held uncommitted edits before the session
   * were counted, once the session changed them. `session_only`: each row
   * counts the session's lines alone. `whole_file`: at least one counts the
   * file against `HEAD`, because no copy of what it held was kept (past the
   * cap, a symbolic link, or a file past `MAX_HASHED_FILE_BYTES`) or its
   * entry in the record could not be read. Absent when the list holds no
   * such path.
   */
  preSessionCounts?: "session_only" | "whole_file";
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

/** A path's size, times, and kind. */
interface Stat {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  changedAtMs: number;
  kind: "file" | "link";
  /** The owner's execute bit, which git reads as mode 100755. */
  executable: boolean;
}

/** A path's size and times, or "absent" when nothing is there. */
async function statOf(
  absolutePath: string,
): Promise<Stat | "absent" | undefined> {
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() && !info.isSymbolicLink()) return undefined;
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      changedAtMs: Math.max(info.mtimeMs, info.ctimeMs),
      kind: info.isFile() ? "file" : "link",
      executable: (info.mode & 0o100) !== 0,
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

/** A copy's name: the first 32 hex digits of the sha256 of its bytes. */
const COPY_NAME = /^[0-9a-f]{32}$/;

/**
 * The first 32 hex digits of the sha256 of a file's bytes, or of a link's
 * target. Read as a stream, so a large file costs time and not memory.
 * Undefined when the read fails.
 *
 * With `keep`, the same pass writes the file's bytes into `keep.dir` under a
 * temporary name and returns that name as `copy`. The caller renames it to
 * the hash once it knows the bytes are the ones it meant to keep, or removes
 * it (`settleCopy`), so a copy is whole or absent and its name says what it
 * holds. A file that grew past `keep.bytes` since it was measured, or a
 * write that fails, leaves no copy and still answers the hash.
 */
async function contentHash(
  absolutePath: string,
  kind: "file" | "link",
  keep?: { dir: string; bytes: number; executable: boolean },
): Promise<{ hash: string; copy?: string } | undefined> {
  const hash = createHash("sha256");
  if (kind === "link") {
    try {
      hash.update(await readlink(absolutePath));
      return { hash: hash.digest("hex").slice(0, 32) };
    } catch {
      return undefined;
    }
  }
  let copy: { temp: string; handle: FileHandle } | null = null;
  if (keep !== undefined) {
    try {
      await mkdir(keep.dir, { recursive: true, mode: 0o700 });
      const temp = join(keep.dir, `.partial-${randomUUID()}`);
      // Git reads the owner's execute bit as the file's mode. A copy of an
      // executable file keeps it, so a patch taken against the copy claims
      // no mode change the session did not make.
      copy = {
        temp,
        handle: await open(temp, "wx", keep.executable ? 0o700 : 0o600),
      };
    } catch {
      copy = null;
    }
  }
  const drop = async () => {
    if (copy === null) return;
    const { temp, handle } = copy;
    copy = null;
    await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
  };
  let written = 0;
  try {
    for await (const chunk of createReadStream(absolutePath)) {
      hash.update(chunk as Buffer);
      if (copy === null) continue;
      written += (chunk as Buffer).length;
      if (keep === undefined || written > keep.bytes) await drop();
      else await copy.handle.write(chunk as Buffer).catch(async () => drop());
    }
  } catch {
    await drop();
    return undefined;
  }
  const digest = hash.digest("hex").slice(0, 32);
  if (copy === null) return { hash: digest };
  const { temp, handle } = copy;
  try {
    await handle.close();
  } catch {
    await unlink(temp).catch(() => undefined);
    return { hash: digest };
  }
  return { hash: digest, copy: temp };
}

/** Name a copy `contentHash` wrote by `name`, or remove it when `name` is undefined. */
async function settleCopy(
  temp: string | undefined,
  name: string | undefined,
): Promise<void> {
  if (temp === undefined) return;
  if (name !== undefined)
    try {
      await rename(temp, join(dirname(temp), name));
      return;
    } catch {
      // Removed below, so no partial copy is left.
    }
  await unlink(temp).catch(() => undefined);
}

/** The bytes a session's copies already take, or 0 when there are none. */
async function copiedBytes(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    try {
      total += (await lstat(join(dir, name))).size;
    } catch {
      // Gone since the listing, so it takes nothing.
    }
  }
  return total;
}

/**
 * Remove the copies of every session `live` does not name, by the directory
 * name the lane gives each session. The daemon calls this after it forgets
 * sealed sessions, which also clears the directories of sessions a crash
 * left behind.
 *
 * `live` is asked after the directory is listed. The daemon runs this off
 * its hook queue, so a session can start while it runs. A session's
 * directory is written only after the session is registered, so any
 * directory the listing holds belongs to a session `live` already names.
 */
export async function removeCopiesOutside(
  root: string,
  live: () => Iterable<string>,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const keep = new Set(live());
  await Promise.all(
    names
      .filter((name) => !keep.has(name))
      .map((name) =>
        rm(join(root, name), { recursive: true, force: true }).catch(
          () => undefined,
        ),
      ),
  );
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
 *
 * With `copies`, each recorded file is also copied into `copies.dir` while
 * it is hashed, in path order until the session's copies would pass
 * `copies.capBytes`. A later reconciliation counts the session's lines in a
 * copied file against the copy (`readSessionChanges`).
 */
export async function readPreexistingPaths(
  exec: ExecAsync,
  root: string,
  startedAtMs: number,
  copies?: PreSessionCopies,
): Promise<PreexistingPaths | undefined> {
  const status = await git(exec, root, STATUS_ARGS);
  if (status === undefined) return undefined;
  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  const listed = parsePorcelainZ(status).sort(byPath);
  const paths: Record<string, PreexistingEntry | null> = {};
  const present: { path: string; absolute: string; found: Stat }[] = [];
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
      present.push({ path: entry.path, absolute, found });
    }),
    UNTRACKED_COUNT_CONCURRENCY,
  );
  // The copies are chosen in path order, so the same files get one whatever
  // order the reads above finished in.
  let room =
    copies === undefined
      ? 0
      : copies.capBytes - (await copiedBytes(copies.dir));
  const planned = present.sort(byPath).map((file) => {
    const hashed = !(
      file.found.kind === "file" && file.found.size > MAX_HASHED_FILE_BYTES
    );
    const copied =
      copies !== undefined &&
      hashed &&
      file.found.kind === "file" &&
      file.found.size <= room;
    if (copied) room -= file.found.size;
    return { ...file, hashed, copied };
  });
  await pooled(
    planned.map((file) => async () => {
      if (!file.hashed) {
        paths[file.path] = ["", file.found.size, file.found.mtimeMs];
        return;
      }
      const read = await contentHash(
        file.absolute,
        file.found.kind,
        file.copied && copies !== undefined
          ? {
              dir: copies.dir,
              bytes: file.found.size,
              executable: file.found.executable,
            }
          : undefined,
      );
      if (read === undefined) return;
      // The stat above can come seconds before the hash, behind the other
      // files' hashes. A write in between would be hashed and copied as what
      // the file held before the session, and the session's edit would never
      // be reported. So a file whose size or times moved is not recorded,
      // and a later read reports it.
      const again = await statOf(file.absolute);
      const still =
        again !== undefined &&
        again !== "absent" &&
        again.size === file.found.size &&
        again.mtimeMs === file.found.mtimeMs &&
        again.ctimeMs === file.found.ctimeMs;
      await settleCopy(read.copy, still ? read.hash : undefined);
      if (still)
        paths[file.path] = [read.hash, file.found.size, file.found.mtimeMs];
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

/**
 * One recorded entry as the state file gave it back: an entry, null for a
 * path that was absent, or undefined for anything else. `daemon.json` is
 * checked only as far as the record being an object, and an entry of the
 * wrong shape threw where it was taken apart.
 */
function entryOf(value: unknown): PreexistingEntry | null | undefined {
  if (value === null) return null;
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  )
    return [value[0], value[1], value[2]];
  return undefined;
}

/**
 * Whether a path from the state file names something inside the repository
 * the way git names it: relative, with no empty, `.`, or `..` segment. Git
 * never lists any other kind.
 */
function insideRepository(path: string): boolean {
  return (
    !/^[A-Za-z]:/.test(path) &&
    !path.includes("\0") &&
    // An empty segment is also a leading or trailing `/`.
    !path.split("/").some((segment) => segment === "" || segment === ".") &&
    !path.split(/[\\/]/).includes("..")
  );
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
  return (await contentHash(absolute, found.kind))?.hash === hash;
}

/** What the session did to one path that held edits before it. */
interface Contribution {
  /** A two-letter code, for `rowsOf`. */
  code: string;
  count: { added: number; removed: number };
  /** The copy it was measured against, or null for a path absent then. */
  copy: string | null;
}

/** Lines added and removed from `from` to `to`, two paths on disk. */
async function lineDelta(
  exec: ExecAsync,
  cwd: string,
  from: string,
  to: string,
): Promise<{ added: number; removed: number } | undefined> {
  const stdout = await git(
    exec,
    cwd,
    ["diff", "--numstat", "--no-index", "-z", "--", from, to],
    [0, 1],
  );
  if (stdout === undefined) return undefined;
  for (const value of parseNumstat(stdout).values()) return value;
  return undefined;
}

/**
 * The session's own change to a path that held uncommitted edits at its
 * first read, measured from what the path held then to what it holds now.
 *
 * A path that was absent then needs no copy: everything it holds now is the
 * session's. A path that held content needs the copy `readPreexistingPaths`
 * kept. The status describes the session's change, not the file against
 * `HEAD`: a file a person created and the session edited is `modified`, and
 * a file a person edited and the session put back as `HEAD` has it is
 * `modified` too, with the lines it took out.
 *
 * Undefined when there is no copy or either side cannot be read. The caller
 * then counts the file against `HEAD`, and the frame says so.
 */
async function contributionOf(
  exec: ExecAsync,
  cwd: string,
  root: string,
  repoRelative: string,
  entry: PreexistingEntry | null,
  copies: string | undefined,
): Promise<Contribution | undefined> {
  const absolute = absoluteIn(root, repoRelative);
  const now = await statOf(absolute);
  if (now === undefined || (now !== "absent" && now.kind !== "file"))
    return undefined;
  let copy: string | null = null;
  if (entry !== null) {
    // The name comes back from the state file, so it is checked before it
    // becomes a path.
    if (copies === undefined || !COPY_NAME.test(entry[0])) return undefined;
    copy = join(copies, entry[0]);
    const kept = await statOf(copy);
    if (kept === undefined || kept === "absent" || kept.kind !== "file")
      return undefined;
  } else if (now === "absent") return undefined;
  const count = await lineDelta(
    exec,
    cwd,
    copy ?? "/dev/null",
    now === "absent" ? "/dev/null" : absolute,
  );
  if (count === undefined) return undefined;
  return {
    code: copy === null ? "A " : now === "absent" ? "D " : "M ",
    count,
    copy,
  };
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

/** One commit as `--format=%H %ct %at %ce` prints it. */
interface LoggedCommit {
  sha: string;
  committedAt: number;
  authoredAt: number;
  email: string;
}

const LOG_FORMAT = "--format=%H %ct %at %ce";

function parseLog(stdout: string): LoggedCommit[] {
  const out: LoggedCommit[] = [];
  for (const record of stdout.split("\0")) {
    const [sha, committed, authored, ...rest] = record.trim().split(" ");
    if (sha === undefined || !COMMIT_NAME.test(sha) || authored === undefined)
      continue;
    out.push({
      sha,
      committedAt: Number(committed),
      authoredAt: Number(authored),
      email: rest.join(" ").toLowerCase(),
    });
  }
  return out;
}

/**
 * A `HEAD` reflog subject git writes when it makes a commit in this
 * worktree: `commit` and its variants (`commit (amend)`), `cherry-pick`,
 * `revert`, and each commit a rebase replays, whichever command ran the
 * rebase (`rebase (pick)`, `rebase -i (reword)`, `pull -q --rebase (pick)`).
 * A pull, a merge, a checkout, and a reset write other subjects.
 */
const MADE_HERE =
  /^(?:(?:commit|cherry-pick|revert)\b[^:]*: |(?:rebase|pull)\b[^(]*\((?:pick|reword|edit|squash|fixup|continue)\): )/;

/**
 * The commits this worktree's `HEAD` reflog records as made here at or
 * after `since` (epoch seconds), newest first. Empty when the reflog is off
 * or cannot be read, which leaves the other tests in `sessionCommits`.
 */
async function madeHere(
  exec: ExecAsync,
  cwd: string,
  since: number,
): Promise<string[]> {
  const stdout = await git(exec, cwd, [
    "log",
    "--walk-reflogs",
    "-z",
    `--max-count=${MAX_REFLOG_ENTRIES}`,
    "--date=unix",
    // `%gd` is `HEAD@{<epoch seconds>}` under `--date=unix`.
    "--format=%H %gd %gs",
    "HEAD",
    "--",
  ]);
  const out: string[] = [];
  for (const record of (stdout ?? "").split("\0")) {
    const match = /^([0-9a-f]+) HEAD@\{(\d+)\} (.*)$/s.exec(record.trim());
    if (match === null) continue;
    const [, sha = "", at = "", subject = ""] = match;
    if (COMMIT_NAME.test(sha) && Number(at) >= since && MADE_HERE.test(subject))
      out.push(sha);
  }
  return out;
}

/**
 * The commits this session made in one worktree, oldest first: the ones an
 * earlier read counted that `baseline..head` no longer lists (a squash merge
 * pulled back is the common case), then every commit that range lists as
 * the session's. Undefined when the range cannot be read.
 *
 * A commit is the session's when it is not a merge, both its committer date
 * and its author date are at or after the session's first read, and one of
 * these holds:
 *
 * - No remote-tracking ref reaches it. A pull fetches before it merges, so
 *   every commit a pull brings in is on a remote-tracking ref by the time
 *   `HEAD` holds it. A commit made here is on none until it is pushed.
 * - This worktree's `HEAD` reflog records it as made here since the first
 *   read (`madeHere`). This counts a commit the agent made under another
 *   email, such as a `GIT_COMMITTER_EMAIL` its shell exports, which tachod
 *   cannot see, after the agent pushed it in the same turn. A pull, a merge,
 *   and a reset write other reflog subjects, so a pulled commit is not one.
 * - Its committer email is the one this repository stamps. This counts a
 *   commit the session pushed in the same turn when the reflog is off.
 *
 * The dates matter as well as the refs. A rebase, an amend, and a
 * cherry-pick stamp a new committer date on a commit someone wrote earlier,
 * so a commit from before the session that the session replayed would count
 * as its own. The author date survives all three.
 *
 * The two reads of the range, less the remote-tracking refs and by email,
 * are filtered and cut in git, so a long range stays a bounded read. The
 * reflog is read to `MAX_REFLOG_ENTRIES`, and each commit it names that the
 * other tests left out is checked against `HEAD` on its own, so an amended
 * or reset commit that left the history is not counted. Only the commits
 * carried over are bounded here. One still in the range is listed again on
 * every read, so leaving it out of the count would drop its files from one
 * frame and bring them back in the next.
 */
async function sessionCommits(
  exec: ExecAsync,
  cwd: string,
  baseline: string,
  head: string,
  firstReadAt: number,
  known: readonly string[],
): Promise<string[] | undefined> {
  if (head === baseline) return [...known];
  // Git dates are whole seconds. A commit made in the same second as the
  // first read counts.
  const since = Math.floor(firstReadAt / 1000);
  const email = await committerEmail(exec, cwd);
  const [local, byEmail, reflog] = await Promise.all([
    git(exec, cwd, [
      "log",
      "--no-merges",
      "-z",
      `--max-count=${MAX_RANGE_COMMITS}`,
      LOG_FORMAT,
      `${baseline}..${head}`,
      "--not",
      "--remotes",
      "--",
    ]),
    // No commit carries an email git cannot name.
    email === undefined
      ? ""
      : git(exec, cwd, [
          "log",
          "--no-merges",
          "-z",
          // `--committer` matches a pattern anywhere in the ident, and the
          // brackets pin it to the email. The exact comparison is still made
          // below.
          "--fixed-strings",
          "--regexp-ignore-case",
          `--committer=<${email}>`,
          `--max-count=${MAX_RANGE_COMMITS}`,
          LOG_FORMAT,
          `${baseline}..${head}`,
          "--",
        ]),
    madeHere(exec, cwd, since),
  ]);
  if (local === undefined || byEmail === undefined) return undefined;
  const counted = new Map<string, LoggedCommit>();
  const count = (commits: LoggedCommit[]) => {
    for (const commit of commits)
      if (commit.committedAt >= since && commit.authoredAt >= since)
        counted.set(commit.sha, commit);
  };
  count(parseLog(local));
  count(parseLog(byEmail).filter((commit) => commit.email === email));
  // The reflog names commits by what `HEAD` was after each one, including
  // commits an amend or a reset has since taken out of the history. Only
  // those still in `baseline..head` count. A commit made after the first
  // read cannot be in the baseline's history, so `head` is the one test.
  const unseen = [...new Set(reflog)]
    .filter((sha) => !counted.has(sha))
    .slice(0, MAX_SESSION_COMMITS);
  if (unseen.length > 0) {
    const shown = await git(exec, cwd, [
      "log",
      "--no-walk=unsorted",
      "--ignore-missing",
      "--no-merges",
      "-z",
      LOG_FORMAT,
      ...unseen,
      "--",
    ]);
    const candidates = parseLog(shown ?? "");
    const reached = new Set<string>();
    await pooled(
      candidates.map((commit) => async () => {
        // Status 0 is "an ancestor", and 1 "not one", which reads as undefined.
        const answer = await git(exec, cwd, [
          "merge-base",
          "--is-ancestor",
          commit.sha,
          head,
        ]);
        if (answer !== undefined) reached.add(commit.sha);
      }),
      UNTRACKED_COUNT_CONCURRENCY,
    );
    count(candidates.filter((commit) => reached.has(commit.sha)));
  }
  // Oldest first. `git log` lists newest first, and the lists interleave, so
  // they are merged by committer date, which a rebase sets in order.
  const inRange = [...counted.values()]
    .reverse()
    .sort((a, b) => a.committedAt - b.committedAt)
    .map((commit) => commit.sha);
  const listed = new Set(inRange);
  const carried = known.filter((sha) => !listed.has(sha));
  return [...carried.slice(-MAX_SESSION_COMMITS), ...inRange];
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
 * The rule, recorded in ADR-188. A path is reported when either:
 *
 * - a commit the session made touched it. The session's commits are the
 *   non-merge commits in `baseline..HEAD` whose committer and author dates
 *   are both at or after the session's first git read, and which no
 *   remote-tracking ref reaches, or this worktree's `HEAD` reflog records as
 *   made here, or carry the committer email this repository stamps
 *   (`committerEmail`), together with the commits an earlier read already
 *   counted (`sessionCommits`). Its status and counts come from the
 *   worktree against the baseline, which covers the committed and the
 *   uncommitted work on it; or
 * - the worktree differs from `HEAD` there, tracked or untracked, and the
 *   path is not one the worktree already held that way at the session's
 *   first read (`readPreexistingPaths`) with its content unchanged since.
 *   Its status and counts come from the worktree against `HEAD`.
 *
 * So a pull, a fetch and reset to upstream, or a rebase onto upstream adds
 * no upstream file: those commits are on a remote-tracking ref, and carry
 * someone else's committer email or dates before the session. The session's
 * own rebased commits still count, because a rebase keeps their author date
 * and gives them new names no remote holds. A commit written before the
 * session and replayed by it does not, because its author date is older.
 * And a commit counted once stays counted, so work a squash merge brought
 * back through a pull is still reported, measured against the baseline. A
 * person's uncommitted edit that was there first is left out until its
 * content changes, and then only the session's lines in it count.
 *
 * The ADR names what the rule cannot tell apart: a commit made after the
 * session's first read by anything else that reaches this worktree before
 * a remote holds it, is made in this worktree, or carries the same email
 * (another session in a sibling worktree, or a person at the keyboard); a
 * pull that updates no remote-tracking ref; and an upstream path the
 * session also committed, whose counts include the upstream change.
 *
 * A session restored from a state file older than the first-read time is
 * measured the old way, every change since the baseline commit, and says
 * so in `basis`. So is a read whose commit or diff probes fail after the
 * status read answered: a frame that overstates and says so is sealed
 * rather than none. Undefined, as everywhere in this file, is a read that
 * did not happen; nothing here turns a failed read into a clean worktree.
 */
export async function readSessionChanges(
  exec: ExecAsync,
  cwd: string,
  start: WorktreeAttribution,
  copies?: string,
): Promise<SessionChanges | undefined> {
  // Both come back from the state file, and both end up as git arguments,
  // so anything that is not a commit name is dropped rather than passed on.
  const known = (
    Array.isArray(start.ownCommits) ? start.ownCommits : []
  ).filter(
    (sha): sha is string => typeof sha === "string" && COMMIT_NAME.test(sha),
  );
  const baseline =
    start.baseline !== undefined && COMMIT_NAME.test(start.baseline)
      ? start.baseline
      : undefined;
  // The measure this rule replaced: every change since the baseline commit.
  // A frame on this measure overstates and says so, which a reader can
  // allow for. No frame at all leaves the run's file rows where the last
  // one put them.
  const sinceBaseline = async (): Promise<SessionChanges | undefined> => {
    // A baseline that is not a commit name is unknown, and measuring from
    // `HEAD` instead would be a different interval.
    if (start.baseline !== undefined && baseline === undefined)
      return undefined;
    const changes = await readWorkingTreeChanges(exec, cwd, baseline);
    return changes === undefined
      ? undefined
      : {
          changes,
          ownCommits: known.slice(-MAX_SESSION_COMMITS),
          basis: "baseline",
          preexisting: "none",
        };
  };
  if (start.firstReadAt === undefined) return sinceBaseline();
  const status = await git(exec, cwd, STATUS_ARGS);
  if (status === undefined) return undefined;
  const listed = parsePorcelainZ(status);
  const [headLine, root] = await Promise.all([
    git(exec, cwd, ["rev-parse", "HEAD"]).then(firstLine),
    git(exec, cwd, ["rev-parse", "--show-toplevel"]).then(firstLine),
  ]);
  const head =
    headLine !== undefined && COMMIT_NAME.test(headLine) ? headLine : undefined;
  let own = known;
  if (baseline !== undefined && head !== undefined) {
    const counted = await sessionCommits(
      exec,
      cwd,
      baseline,
      head,
      start.firstReadAt,
      own,
    );
    // A range too long for the exec's buffer or its timeout lands here.
    if (counted === undefined) return sinceBaseline();
    own = counted;
  }
  const touched = await filesOfCommits(exec, cwd, own);
  if (touched === undefined) return sinceBaseline();
  own = own.filter((sha) => touched.present.has(sha));
  const headRef =
    head ?? ((await provenUnborn(exec, cwd)) ? EMPTY_TREE_OBJECT : undefined);
  if (headRef === undefined) return sinceBaseline();
  const fromBaseline =
    baseline !== undefined && baseline !== head && touched.paths.size > 0;
  const [atHead, atBaseline] = await Promise.all([
    diffAgainst(exec, cwd, headRef),
    fromBaseline ? diffAgainst(exec, cwd, baseline) : undefined,
  ]);
  if (atHead === undefined || (fromBaseline && atBaseline === undefined))
    return sinceBaseline();

  const rows = new Map<string, string>();
  const counts = new Map<string, { added: number; removed: number }>();
  const baselinePaths = new Set<string>();
  for (const entry of atBaseline?.entries ?? []) {
    if (!touched.paths.has(entry.path)) continue;
    rows.set(entry.path, entry.code);
    baselinePaths.add(entry.path);
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

  // What the worktree held before the session. A path still holding it is
  // left out. A path changed since is counted from what it held then, when
  // that can be read, and against `HEAD` otherwise. A path the session
  // committed is its own whatever it held before.
  const preexisting =
    typeof start.preexisting?.paths === "object" &&
    start.preexisting.paths !== null
      ? start.preexisting
      : undefined;
  const fromPreSession = new Map<string, string | null>();
  let wholeFile = false;
  // Set when an entry could not be used, so its path's earlier edits, if
  // any, are in the list and the frame says the record was partial.
  let lost = false;
  if (preexisting !== undefined && root !== undefined) {
    // The keys come back from the state file and become paths on disk and
    // git arguments. One that leaves the repository is dropped.
    const kept = Object.keys(preexisting.paths).filter(
      (path) => !touched.paths.has(path),
    );
    const recorded = kept.filter(insideRepository).sort();
    if (recorded.length < kept.length) lost = true;
    const found = new Map<string, Contribution | "unchanged" | undefined>();
    await pooled(
      recorded.map((path) => async () => {
        const entry = entryOf(preexisting.paths[path]);
        if (entry === undefined) {
          lost = true;
          // Its row, if any, counts the whole file against `HEAD`.
          if (rows.has(path)) wholeFile = true;
          return;
        }
        found.set(
          path,
          (await unchangedSince(root, path, entry))
            ? "unchanged"
            : await contributionOf(exec, cwd, root, path, entry, copies),
        );
      }),
      UNTRACKED_COUNT_CONCURRENCY,
    );
    // Applied in path order, so the rows come out the same on every read.
    for (const path of recorded) {
      const own = found.get(path);
      if (own === "unchanged") rows.delete(path);
      else if (own !== undefined) {
        rows.set(path, own.code);
        counts.set(path, own.count);
        fromPreSession.set(path, own.copy);
      } else if (found.has(path) && rows.has(path)) wholeFile = true;
    }
  }

  const entries = [...rows].map(([path, code]) => ({ code, path }));
  if (root !== undefined)
    await countUntracked(exec, cwd, root, entries, counts);
  return {
    changes: rowsOf(entries, counts, root),
    measured: {
      headRef,
      fromBaseline: entries
        .map((entry) => entry.path)
        .filter((path) => baselinePaths.has(path)),
      fromHead: entries
        .map((entry) => entry.path)
        .filter(
          (path) => !baselinePaths.has(path) && !fromPreSession.has(path),
        ),
      fromPreSession: [...fromPreSession].map(([path, copy]) => ({
        path,
        copy,
      })),
    },
    ownCommits: own.slice(-MAX_SESSION_COMMITS),
    basis: "session",
    preexisting:
      preexisting === undefined
        ? "none"
        : preexisting.complete && !lost
          ? "complete"
          : "partial",
    ...(wholeFile
      ? { preSessionCounts: "whole_file" as const }
      : fromPreSession.size > 0
        ? { preSessionCounts: "session_only" as const }
        : {}),
  };
}
