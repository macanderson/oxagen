/**
 * What actually changed on disk, read from git rather than from the tool
 * stream.
 *
 * Every file fact the collector has today is attested: a tool announced a
 * path, a hook saw the announcement, and the record repeats it. That record
 * cannot say whether the write landed, cannot tell a create from a modify
 * from a delete, and carries no line counts. It is also blind to the largest
 * category of change there is. A `Bash` frame says `sed -i ...`, `npm run
 * build` or `git checkout .`, and the effect of those commands on the
 * worktree appears nowhere: the hook sees the command, never its result.
 *
 * Git is the observed side of the same question. It reports what the
 * worktree holds now, not what an agent said it would hold, and it reports
 * it the same way whichever tool did the writing. That difference between
 * attested and observed is the distinction the enforcement tier ladder is
 * built on (docs/specs/gateway/spec.md section 3, ADR-095): a higher tier is
 * one where Oxagen saw the thing itself instead of being told about it. File
 * change belongs on the observed side, so it is read here.
 *
 * Three rules hold for everything in this file.
 *
 * Nothing throws. A worktree is an operator's machine, and it can be a
 * directory that is not a repo, a repo with no commits, a submodule, a
 * detached head, or a host with no git at all. Every one of those returns
 * undefined or an empty list. The collector loses a fact; it does not lose
 * the session.
 *
 * Nothing is unbounded. Output is truncated before it is parsed, so a
 * generated directory of a hundred thousand untracked files costs a fixed
 * amount of memory and a fixed amount of parsing.
 *
 * Nothing leaves in the clear that should not. The remote URL names the
 * customer's repository and often carries a token in its userinfo, so it is
 * never stored: the field is `git_remote_digest` and its schema type is a
 * sha256 digest, which is enough to tell two hosts working the same
 * repository apart without saying which repository it is.
 */
import { digestBytes, type Sha256Digest } from "../digest";
import type { Exec } from "../host/service";

/** Repository facts for one working directory, all optional. */
export interface GitFacts {
  head_sha?: string;
  branch?: string;
  dirty?: boolean;
  remote_digest?: Sha256Digest;
}

export type GitChangeStatus = "added" | "modified" | "deleted" | "renamed";

/** One path the worktree holds differently from `HEAD`. */
export interface GitWorkingTreeChange {
  /** Absolute path, or the repo-relative one when the root cannot be read. */
  path: string;
  repo_relative_path: string;
  status: GitChangeStatus;
  lines_added: number;
  lines_removed: number;
}

/**
 * The most stdout this module parses from one git invocation. A worktree
 * with a build directory in it produces megabytes of `status` output, and
 * the collector must cost the same whether or not the agent ran a build.
 */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

/** The most changed paths one reconciliation reports. */
export const MAX_CHANGED_PATHS = 2_000;

/**
 * Run one git command in `cwd` and return its stdout, or undefined for every
 * failure there is: git missing, a directory that is not a repo, a non-zero
 * exit, or a spawn that threw.
 *
 * `--no-optional-locks` keeps a read from taking the index lock, so
 * observing a worktree never contends with the agent working in it.
 * `core.quotePath=false` stops git from escaping non-ASCII paths, which
 * keeps the parsing below to one quoting case rather than two.
 */
function git(exec: Exec, cwd: string, args: string[]): string | undefined {
  let result: ReturnType<Exec>;
  try {
    result = exec("git", [
      "-C",
      cwd,
      "--no-optional-locks",
      "-c",
      "core.quotePath=false",
      ...args,
    ]);
  } catch {
    return undefined;
  }
  if (result.status !== 0) return undefined;
  const stdout = result.stdout ?? "";
  return stdout.length > MAX_STDOUT_BYTES
    ? stdout.slice(0, MAX_STDOUT_BYTES)
    : stdout;
}

function firstLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const line = value.split("\n", 1)[0]?.trim();
  return line === undefined || line.length === 0 ? undefined : line;
}

/**
 * Head, branch, dirtiness and the digested remote for one working directory.
 *
 * Undefined means this directory is not a repository Oxagen can read, which
 * is a fact in itself: the caller records no git context rather than
 * recording a guess. A repository that answers `HEAD` but has no branch
 * (detached) or no remote simply omits those members.
 */
export function readGitFacts(exec: Exec, cwd: string): GitFacts | undefined {
  const head = firstLine(git(exec, cwd, ["rev-parse", "HEAD"]));
  if (head === undefined) return undefined;
  const facts: GitFacts = { head_sha: head };
  const branch = firstLine(git(exec, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  // `HEAD` is what a detached checkout answers, and it names no branch.
  if (branch !== undefined && branch !== "HEAD") facts.branch = branch;
  const status = git(exec, cwd, ["status", "--porcelain"]);
  // Undefined here is a failed read, not a clean tree, so the field is left
  // off rather than asserting cleanliness nobody observed.
  if (status !== undefined) facts.dirty = status.trim().length > 0;
  const remote = firstLine(git(exec, cwd, ["remote", "get-url", "origin"]));
  if (remote !== undefined) facts.remote_digest = digestBytes(remote);
  return facts;
}

/** The index and worktree letters of a porcelain v1 entry, mapped to a status. */
function statusOf(code: string): GitChangeStatus {
  if (code === "??" || code === "!!") return "added";
  for (const letter of code) {
    if (letter === "R" || letter === "C") return "renamed";
    if (letter === "A") return "added";
    if (letter === "D") return "deleted";
    if (letter === "M" || letter === "U" || letter === "T") return "modified";
  }
  return "modified";
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * Each entry is `XY <path>` followed by a NUL. A rename or a copy carries
 * its original path in the next NUL-terminated field, which is why this
 * cannot be a plain split-and-map: the field after an `R` entry is not an
 * entry. The original path is dropped, because the column being filled
 * names the path as it stands now.
 */
export function parsePorcelainZ(
  stdout: string,
): { code: string; path: string }[] {
  const fields = stdout.split("\0");
  const out: { code: string; path: string }[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === undefined || field.length < 4) continue;
    const code = field.slice(0, 2);
    // A well-formed entry is two status letters, a space, then the path.
    if (field[2] !== " ") continue;
    const path = field.slice(3);
    if (path.length === 0) continue;
    out.push({ code, path });
    // Consume the original path of a rename or a copy.
    if (code.includes("R") || code.includes("C")) i += 1;
    if (out.length >= MAX_CHANGED_PATHS) break;
  }
  return out;
}

/** Unquote the C-quoted path form git falls back to for tabs and newlines. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  return inner.replace(/\\(.)/g, (_match, char: string) => {
    if (char === "n") return "\n";
    if (char === "t") return "\t";
    if (char === "r") return "\r";
    return char;
  });
}

/**
 * Resolve the path field of a numstat row. Git writes a rename as
 * `old => new`, and shortens a shared prefix or suffix into
 * `src/{old => new}.ts`. Both forms resolve to the new path.
 */
export function resolveNumstatPath(field: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
  if (braced !== null) {
    return `${braced[1] ?? ""}${braced[3] ?? ""}${braced[4] ?? ""}`.replace(
      /\/\//g,
      "/",
    );
  }
  const arrow = field.split(" => ");
  return arrow.length === 2 ? (arrow[1] ?? field) : field;
}

/**
 * Parse `git diff --numstat` into per-path line counts.
 *
 * A binary file is reported as `-` for both counts, which is not zero and
 * not a parse failure: it is git saying the question does not apply. Both
 * counts are recorded as zero, and the path still appears, because a binary
 * file that changed is a change.
 */
export function parseNumstat(
  stdout: string,
): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = Number.parseInt(parts[0] ?? "", 10);
    const removed = Number.parseInt(parts[1] ?? "", 10);
    const path = unquote(resolveNumstatPath(parts.slice(2).join("\t")));
    if (path.length === 0) continue;
    out.set(path, {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
    });
  }
  return out;
}

/**
 * Every path the worktree holds differently from `HEAD`, with line counts.
 *
 * The status listing decides which paths are reported, and the numstat only
 * supplies counts for them. That order matters: an untracked file appears in
 * `status` and in no diff at all, so it would be invisible the other way
 * round, and an untracked file is exactly the create the tool stream is
 * worst at recording.
 *
 * The diff is taken against `HEAD` rather than against the index. A bare
 * `git diff` reports the unstaged half only, so an agent that ran `git add`
 * would have its work counted as zero lines, which is the same blindness
 * this pass exists to remove. A repository with no commits has no `HEAD` to
 * diff, and falls back to the unstaged form.
 */
export function readWorkingTreeChanges(
  exec: Exec,
  cwd: string,
): GitWorkingTreeChange[] {
  const status = git(exec, cwd, ["status", "--porcelain=v1", "-z"]);
  if (status === undefined) return [];
  const entries = parsePorcelainZ(status);
  if (entries.length === 0) return [];
  const numstatOut =
    git(exec, cwd, ["diff", "--numstat", "HEAD"]) ??
    git(exec, cwd, ["diff", "--numstat"]) ??
    "";
  const counts = parseNumstat(numstatOut);
  const root = firstLine(git(exec, cwd, ["rev-parse", "--show-toplevel"]));
  return entries.map((entry) => {
    const repoRelative = unquote(entry.path);
    const count = counts.get(repoRelative);
    return {
      path:
        root === undefined
          ? repoRelative
          : `${root.replace(/\/$/, "")}/${repoRelative}`,
      repo_relative_path: repoRelative,
      status: statusOf(entry.code),
      lines_added: count?.added ?? 0,
      lines_removed: count?.removed ?? 0,
    };
  });
}
