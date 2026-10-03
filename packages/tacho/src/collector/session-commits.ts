/**
 * The commits a session made, as the reconciliation frame seals them
 * (`session_commits`, ADR-297).
 *
 * `readSessionChanges` decides which commits are the session's, under
 * ADR-188's rule, and keeps their names in daemon state. This module reads
 * what the frame says about each one: its parents and dates, its subject,
 * its files and line counts, its patch id, the test that counted it, the
 * tool call that made it, and whether it holds a path the session never
 * wrote. The control plane stores them, so it knows which run made which
 * commit, which GitHub cannot tell it.
 *
 * The rules of `git-facts.ts` hold here too. Nothing throws, nothing is
 * unbounded, every git read passes `--no-optional-locks`, and reads that do
 * not depend on each other are made together. A failed read of the commits
 * or their files gives no list, because an empty one would be a claim. A
 * failed read of the patch ids, the reflog, or the root leaves only the
 * fields it feeds null or absent.
 */
import { join } from "node:path";
import {
  MAX_COMMIT_FILES,
  MAX_COMMIT_PARENTS,
  MAX_COMMIT_SUBJECT,
  MAX_SESSION_COMMIT_ITEMS,
} from "../envelope";
import type { ExecAsync } from "../host/service";
import { toProtocolTimestamp } from "../timestamp";
import {
  firstLine,
  type GitWorkingTreeChange,
  git,
  parseNameStatusZ,
  parseNumstat,
  rowsOf,
} from "./git-facts";
import type { CommitTest } from "./session-changes";

/** The most `HEAD` reflog entries read to date the commits. */
const MAX_REFLOG_ENTRIES = 1_024;

/**
 * One Bash tool call that ran `git commit`, as the hook handler saw it, in
 * epoch ms. `to` is unset until the call's `PostToolUse` arrives.
 */
export interface CommitCall {
  toolUseId: string;
  from: number;
  to?: number;
}

/** One file of a commit, as the frame lists it. */
export interface SessionCommitFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
}

/** One commit, as the frame lists it (ADR-297 section 9). */
export interface SessionCommitItem {
  sha: string;
  parent_shas: string[];
  kind: "change" | "merge";
  patch_id: string | null;
  authored_at: string;
  committed_at: string;
  subject: string;
  added: number;
  removed: number;
  files_total: number;
  files: SessionCommitFile[];
  /** Absent only for a commit a daemon counted before it kept tests. */
  test?: CommitTest;
  tool_use_id?: string;
  files_outside_session?: boolean;
}

/** The three body fields the frame carries. */
export interface SessionCommitList {
  session_commits: SessionCommitItem[];
  session_commits_total: number;
  session_commits_truncated: boolean;
}

/** What `readSessionCommits` reads about. */
export interface SessionCommitInput {
  /** The session's own commits, from `SessionChanges.ownCommits`. */
  own: readonly string[];
  /** The session's merges, from `SessionChanges.commitFacts`. */
  merges: readonly string[];
  tests: Readonly<Record<string, CommitTest>>;
  /** The Bash calls that ran `git commit`. Absent after a daemon restart. */
  calls?: readonly CommitCall[];
  /**
   * The absolute paths the session's tool calls wrote or edited. Absent
   * when the daemon does not hold them all, as after a restart.
   */
  written?: ReadonlySet<string>;
}

interface CommitMeta {
  sha: string;
  parents: string[];
  authoredAt: number;
  committedAt: number;
  subject: string;
}

const META_FORMAT = "--format=%H%x1f%P%x1f%at%x1f%ct%x1f%s";

function parseMeta(stdout: string): CommitMeta[] {
  const out: CommitMeta[] = [];
  for (const record of stdout.split("\0")) {
    const [sha, parents, authored, committed, ...subject] = record
      .replace(/^\n/, "")
      .split("\x1f");
    const authoredAt = Number(authored);
    const committedAt = Number(committed);
    if (
      sha === undefined ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) ||
      !Number.isFinite(authoredAt) ||
      !Number.isFinite(committedAt)
    )
      continue;
    out.push({
      sha,
      parents: (parents ?? "").split(" ").filter((p) => p.length > 0),
      authoredAt,
      committedAt,
      subject: subject.join("\x1f"),
    });
  }
  return out;
}

/** One file of a commit, from the row `rowsOf` gives for it. */
function fileOf(row: GitWorkingTreeChange): SessionCommitFile {
  return {
    path: row.repo_relative_path,
    status: row.status,
    added: row.lines_added,
    removed: row.lines_removed,
  };
}

/** Sorted by path, so a cut keeps the same files on every read. */
function byPath(a: SessionCommitFile, b: SessionCommitFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Split `git log -z --format=%x01%H <diff option>` into each commit's diff
 * output. Each commit is `\x01<sha>\0`, then its entries after a newline.
 */
function byCommit(stdout: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of (stdout ?? "").split("\x01")) {
    const end = chunk.indexOf("\0");
    if (end < 0) continue;
    const sha = chunk.slice(0, end).trim();
    if (sha.length > 0) out.set(sha, chunk.slice(end + 1).replace(/^\n/, ""));
  }
  return out;
}

/**
 * Each change commit's patch id, as `git patch-id --stable` gives it over
 * the commit's diff against its first parent. `ExecAsync` takes no input,
 * so the two commands are joined by a shell. A failed read gives no ids,
 * and each commit's `patch_id` is then null.
 */
const PATCH_IDS = [
  'cwd="$1"; shift;',
  'git -C "$cwd" --no-optional-locks -c core.quotePath=false',
  "-c diff.noprefix=false -c diff.mnemonicPrefix=false",
  "log --no-walk=unsorted --ignore-missing -p --no-color --no-ext-diff",
  '--no-textconv --find-renames --format="commit %H" "$@" --',
  "| git patch-id --stable",
].join(" ");

async function patchIds(
  exec: ExecAsync,
  cwd: string,
  shas: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (shas.length === 0) return out;
  try {
    const result = await exec("sh", ["-c", PATCH_IDS, "sh", cwd, ...shas]);
    if (result.status !== 0) return out;
    for (const line of (result.stdout ?? "").split("\n")) {
      const [patchId, sha] = line.trim().split(" ");
      if (patchId !== undefined && sha !== undefined && patchId.length > 0)
        out.set(sha, patchId);
    }
  } catch {
    // No ids: each commit's `patch_id` is null.
  }
  return out;
}

/**
 * When `HEAD` first named each commit, in epoch seconds, from this
 * worktree's reflog. The reflog lists newest first, so the last entry for a
 * commit is the one that made it. Empty when the reflog is off.
 */
async function reflogTimes(
  exec: ExecAsync,
  cwd: string,
): Promise<Map<string, number>> {
  const stdout = await git(exec, cwd, [
    "log",
    "--walk-reflogs",
    "-z",
    `--max-count=${MAX_REFLOG_ENTRIES}`,
    "--date=unix",
    // `%gd` is `HEAD@{<epoch seconds>}` under `--date=unix`.
    "--format=%H %gd",
    "HEAD",
    "--",
  ]);
  const out = new Map<string, number>();
  for (const record of (stdout ?? "").split("\0")) {
    const match = /^([0-9a-f]+) HEAD@\{(\d+)\}$/.exec(record.trim());
    if (match !== null) out.set(match[1] ?? "", Number(match[2]));
  }
  return out;
}

/**
 * The one call whose run covers the moment `HEAD` first named the commit.
 * Reflog times are whole seconds, so each window is widened to whole
 * seconds. Two matching calls, as in parallel Bash calls, name neither.
 */
function callAt(
  at: number | undefined,
  calls: readonly CommitCall[],
): string | undefined {
  if (at === undefined) return undefined;
  const matching = calls.filter(
    (call) =>
      call.to !== undefined &&
      Math.floor(call.from / 1000) <= at &&
      at <= Math.ceil(call.to / 1000),
  );
  return matching.length === 1 ? matching[0]?.toolUseId : undefined;
}

/**
 * The `session_commits` fields for one worktree's reconciliation.
 * Undefined when git cannot list the commits at all, and the frame is then
 * sealed without the fields rather than with an empty list, which would
 * claim the session made none.
 */
export async function readSessionCommits(
  exec: ExecAsync,
  cwd: string,
  input: SessionCommitInput,
): Promise<SessionCommitList | undefined> {
  const named = [...new Set([...input.own, ...input.merges])];
  if (named.length === 0)
    return {
      session_commits: [],
      session_commits_total: 0,
      session_commits_truncated: false,
    };
  const shown = await git(exec, cwd, [
    "log",
    "--no-walk=unsorted",
    "--ignore-missing",
    "-z",
    META_FORMAT,
    ...named,
    "--",
  ]);
  if (shown === undefined) return undefined;
  // Oldest first, by committer date, which a rebase sets in order. A commit
  // a garbage collection removed is not listed.
  const present = parseMeta(shown).sort(
    (a, b) => a.committedAt - b.committedAt,
  );
  const kept = present.slice(-MAX_SESSION_COMMIT_ITEMS);
  const changes = kept
    .filter((commit) => commit.parents.length <= 1)
    .map((commit) => commit.sha);
  const fileLog = (option: string) =>
    changes.length === 0
      ? Promise.resolve("")
      : git(exec, cwd, [
          "log",
          "--no-walk=unsorted",
          "--ignore-missing",
          "-z",
          option,
          "--find-renames",
          "--format=%x01%H",
          ...changes,
          "--",
        ]);
  const calls = input.calls ?? [];
  const [names, numstat, ids, times, root] = await Promise.all([
    fileLog("--name-status"),
    fileLog("--numstat"),
    patchIds(exec, cwd, changes),
    calls.length > 0
      ? reflogTimes(exec, cwd)
      : Promise.resolve(new Map<string, number>()),
    input.written !== undefined
      ? git(exec, cwd, ["rev-parse", "--show-toplevel"]).then(firstLine)
      : Promise.resolve(undefined),
  ]);
  if (names === undefined || numstat === undefined) return undefined;
  const namesOf = byCommit(names);
  const countsOf = byCommit(numstat);

  const items = kept.map((commit): SessionCommitItem => {
    const merge = commit.parents.length > 1;
    // A merge's diff against its first parent is the other branch's work,
    // so it lists no files and counts no lines (ADR-297 section 3).
    const rows = merge
      ? []
      : rowsOf(
          parseNameStatusZ(namesOf.get(commit.sha) ?? ""),
          parseNumstat(countsOf.get(commit.sha) ?? ""),
          "",
        );
    const files = rows.map(fileOf).sort(byPath);
    const test = input.tests[commit.sha];
    const toolUseId = callAt(times.get(commit.sha), calls);
    const written = input.written;
    const outside =
      merge || written === undefined || root === undefined
        ? undefined
        : files.some((file) => !written.has(join(root, file.path)));
    return {
      sha: commit.sha,
      parent_shas: commit.parents.slice(0, MAX_COMMIT_PARENTS),
      kind: merge ? "merge" : "change",
      patch_id: merge ? null : (ids.get(commit.sha) ?? null),
      authored_at: toProtocolTimestamp(commit.authoredAt * 1000),
      committed_at: toProtocolTimestamp(commit.committedAt * 1000),
      subject: Array.from(commit.subject).slice(0, MAX_COMMIT_SUBJECT).join(""),
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      files_total: files.length,
      files: files.slice(0, MAX_COMMIT_FILES),
      ...(test !== undefined ? { test } : {}),
      ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
      ...(outside !== undefined ? { files_outside_session: outside } : {}),
    };
  });
  return {
    session_commits: items,
    session_commits_total: present.length,
    session_commits_truncated: present.length > kept.length,
  };
}
