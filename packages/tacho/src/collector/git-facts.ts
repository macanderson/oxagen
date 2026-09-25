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
 * A failed diff stays unknown. Only a symbolic HEAD with no branch ref is
 * unborn and can be measured against the empty tree.
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
 *
 * Nothing here blocks the caller. Every read takes `ExecAsync`, not the
 * synchronous `Exec` the CLI and the service manager use, because the one
 * caller of this module is the collector daemon and the daemon answers hooks
 * on the same event loop a synchronous spawn would stop. The few reads that
 * go to the filesystem instead of git, the size, times, and hash of a file
 * that was dirty before a session started, use `node:fs/promises` and a
 * stream for the same reason. Reads that do not depend on each other are
 * issued together, which is safe because they are all reads and
 * `--no-optional-locks` keeps every one of them off the index lock, so two
 * concurrent git processes in one worktree contend for nothing and neither
 * can disturb the agent working there.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { dirname } from "node:path";
import { digestBytes, type Sha256Digest } from "../digest";
import { MAX_OBSERVED_CHANGES } from "../envelope";
import type { ExecAsync, ExecResult } from "../host/service";

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
 * Git's empty tree, the object every repository has before its first
 * commit. Diffing against it is what `HEAD` would mean if `HEAD` existed,
 * and the hash is a constant of the format rather than of any repository.
 */
const EMPTY_TREE_OBJECT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The most stdout this module parses from one git invocation. A worktree
 * with a build directory in it produces megabytes of `status` output, and
 * the collector must cost the same whether or not the agent ran a build.
 */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

/** The most changed paths one reconciliation reports. */
export const MAX_CHANGED_PATHS = 2_000;

/**
 * The most untracked files one reconciliation measures line counts for.
 *
 * An untracked create appears in `git status` and in no diff, so neither
 * `diff --numstat HEAD` nor the unstaged fallback offers a count for it. It
 * was previously recorded as zero added lines, and ingest then persisted
 * that zero as the run's observed line count, which is a different claim
 * from "not measured": an agent that wrote a four hundred line file read as
 * an agent that wrote nothing. The count is now measured, one
 * `diff --numstat --no-index` per untracked file.
 *
 * That costs a process per file, so it is bounded twice. This constant caps
 * how many files are measured in one reconciliation, and
 * `UNTRACKED_COUNT_CONCURRENCY` caps how many run at once. The cap is rarely
 * reached in practice because porcelain v1 collapses a wholly untracked
 * directory into one entry: a generated tree of a hundred thousand files is
 * one path here, not a hundred thousand.
 *
 * Two cases still record zero rather than a measurement, and both are
 * stated rather than hidden: a directory entry, which names a subtree and
 * not a file, and any file past this cap. Telling those apart from a real
 * zero needs a field the observed-change schema does not have, which is a
 * change to the envelope and to ingest rather than to this reader.
 */
export const MAX_UNTRACKED_LINE_COUNTS = 64;

/** The most untracked-file probes in flight at once. */
export const UNTRACKED_COUNT_CONCURRENCY = 4;

/**
 * Run one git command in `cwd` and return its stdout, or undefined for every
 * failure there is: git missing, a directory that is not a repo, a non-zero
 * exit, or a spawn that threw.
 *
 * `--no-optional-locks` keeps a read from taking the index lock, so
 * observing a worktree never contends with the agent working in it.
 * `core.quotePath=false` stops git from escaping non-ASCII paths, which
 * keeps the parsing below to one quoting case rather than two.
 *
 * `okStatus` names the exit codes that mean the command answered. It is `[0]`
 * for every read but the untracked-file probe, where git follows `diff` and
 * exits 1 to say the two inputs differ, which is the answer being asked for.
 */
async function git(
  exec: ExecAsync,
  cwd: string,
  args: string[],
  okStatus: readonly number[] = [0],
): Promise<string | undefined> {
  let result: ExecResult;
  try {
    result = await exec("git", [
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
  if (result.status === null || !okStatus.includes(result.status))
    return undefined;
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
 * The top of the worktree that holds `dir`, or undefined when `dir` is in no
 * repository. A linked worktree answers its own root, not the primary
 * checkout's. The daemon reads every other git fact at this root, and keys a
 * session's baseline by it.
 */
export async function readGitRoot(
  exec: ExecAsync,
  dir: string,
): Promise<string | undefined> {
  return firstLine(await git(exec, dir, ["rev-parse", "--show-toplevel"]));
}

/**
 * Head, branch, dirtiness and the digested remote for one working directory.
 *
 * Undefined means this directory is not a repository Oxagen can read, which
 * is a fact in itself: the caller records no git context rather than
 * recording a guess. A repository that answers `HEAD` but has no branch
 * (detached) or no remote simply omits those members.
 */
export async function readGitFacts(
  exec: ExecAsync,
  cwd: string,
): Promise<GitFacts | undefined> {
  const head = firstLine(await git(exec, cwd, ["rev-parse", "HEAD"]));
  if (head === undefined) return undefined;
  const facts: GitFacts = { head_sha: head };
  // `HEAD` gates the other three: a directory that cannot answer it is not a
  // repository, and there is nothing to ask it. The three that follow answer
  // independent questions, so they are asked at once rather than in series.
  const [branch, status, remote] = await Promise.all([
    git(exec, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then(firstLine),
    git(exec, cwd, ["status", "--porcelain"]),
    git(exec, cwd, ["remote", "get-url", "origin"]).then(firstLine),
  ]);
  // `HEAD` is what a detached checkout answers, and it names no branch.
  if (branch !== undefined && branch !== "HEAD") facts.branch = branch;
  // Undefined here is a failed read, not a clean tree, so the field is left
  // off rather than asserting cleanliness nobody observed.
  if (status !== undefined) facts.dirty = status.trim().length > 0;
  if (remote !== undefined)
    facts.remote_digest = digestBytes(canonicalRemote(remote));
  return facts;
}

/**
 * The remote URL reduced to the repository it names, so two hosts working
 * the same repository digest to the same value.
 *
 * The digest exists to tell repositories apart without saying which one, so
 * it has to depend on the repository and nothing else. A remote often
 * carries per-machine credentials in its userinfo
 * (`https://user:token@host/acme/repo.git`), and hashing that raw made the
 * identity depend on the token: two developers, or one developer after a
 * rotation, produced different digests for the same repository and nothing
 * downstream could correlate them.
 *
 * So the userinfo, the query, and the fragment go, the scheme and the `.git`
 * suffix go, `scp` syntax (`git@host:acme/repo.git`) is folded onto the same
 * shape as its URL form, and the host is lowercased. The path is not, because a repository name is
 * case sensitive on most forges. None of this is reversible and none of it
 * needs to be: nothing reads the digest back, it is only compared.
 */
export function canonicalRemote(remote: string): string {
  let value = remote.trim();
  // `git@host:acme/repo.git` is the same repository as
  // `ssh://git@host/acme/repo.git`.
  const scp = /^([^/@]+)@([^/:]+):(.+)$/.exec(value);
  if (scp !== null && !value.includes("://"))
    value = `ssh://${scp[2] ?? ""}/${scp[3] ?? ""}`;
  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  // Userinfo, which is where a token rides.
  const at = value.indexOf("@");
  const firstSlash = value.indexOf("/");
  if (at !== -1 && (firstSlash === -1 || at < firstSlash))
    value = value.slice(at + 1);
  // The query and the fragment, which is where the other kind of token rides
  // (`https://host/acme/repo.git?access_token=...`). Left on, the token
  // changed the digest on every rotation, and the `.git` suffix was no longer
  // at the end for the line below to find.
  value = value.replace(/[?#].*$/, "");
  // Trailing slashes first: the `.git` anchor does not match with one after
  // it, so the other order left `repo.git/` carrying its suffix.
  value = value.replace(/\/+$/, "").replace(/\.git$/, "");
  const slash = value.indexOf("/");
  if (slash === -1) return value.toLowerCase();
  return `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
}

/**
 * The status of one path against `HEAD`, from a two-letter code, or
 * undefined when the path holds what `HEAD` holds.
 *
 * Two readers hand codes here. A name-status diff gives one letter, which
 * already describes the worktree against the ref and arrives as `"M "`. A
 * porcelain v1 entry gives two: the index against `HEAD`, then the worktree
 * against the index. Porcelain letters decide the status only where no
 * name-status diff exists to ask, which is the reader without a baseline
 * (`readWorkingTreeChanges`) and the untracked `??` entries every reader
 * takes from `status`. The session reader derives every tracked status from
 * the same diff that gives its line counts, so the two fields of a row
 * describe one state.
 *
 * Where porcelain letters are read, they are read as one state rather than
 * left to right. Left to right, a file staged as modified and then deleted
 * (`MD`) reported `modified` beside a line count that described its
 * deletion, and a file added to the index and then deleted (`AD`) reported
 * `added` although the worktree holds nothing `HEAD` does not.
 */
function statusOf(code: string): GitChangeStatus | undefined {
  if (code === "??" || code === "!!") return "added";
  const index = code[0] ?? " ";
  const worktree = code[1] ?? " ";
  if (index === "U" || worktree === "U" || code === "AA" || code === "DD")
    return "modified";
  // Gone from the worktree. A path the index added and the worktree then
  // removed was never in `HEAD`, so against `HEAD` nothing changed.
  if (worktree === "D") return index === "A" ? undefined : "deleted";
  if (index === "R" || index === "C") return "renamed";
  if (index === "A") return "added";
  if (index === "D") return "deleted";
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

/**
 * `git diff --name-status -z <ref>` into `{ code, path }`, the same shape
 * `parsePorcelainZ` answers so the two merge without a second vocabulary.
 *
 * NUL-delimited rather than the default, because the default C-quotes any
 * path that needs it and this reader must key by the same spelling the
 * porcelain status uses. A rename writes three fields — status, old path,
 * new path — and the new path is the one the run changed.
 */
export function parseNameStatusZ(
  stdout: string,
): { code: string; path: string }[] {
  const fields = stdout.split("\0");
  const out: { code: string; path: string }[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i];
    if (code === undefined || code.length === 0) continue;
    const letter = code[0] ?? "";
    if (!"AMDRCTU".includes(letter)) continue;
    // A rename or copy spends its next field on the old path.
    const pathIndex = letter === "R" || letter === "C" ? i + 2 : i + 1;
    const path = fields[pathIndex];
    i = pathIndex;
    if (path === undefined || path.length === 0) continue;
    // Two letters, so `statusOf` reads it the way it reads a porcelain code.
    out.push({ code: `${letter} `, path });
    if (out.length >= MAX_CHANGED_PATHS) break;
  }
  return out;
}

/** Parse Git's NUL-delimited numstat. Renames carry separate old/new fields. */
export function parseNumstat(
  stdout: string,
): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>();
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const row = fields[i] ?? "";
    const first = row.indexOf("\t");
    const second = row.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = row.slice(0, first);
    const removed = row.slice(first + 1, second);
    let path = row.slice(second + 1);
    if (path === "") {
      path = fields[i + 2] ?? "";
      i += 2;
    }
    if (!path || !/^(?:\d+|-)$/.test(added) || !/^(?:\d+|-)$/.test(removed))
      continue;
    out.set(path, {
      added: added === "-" ? 0 : Number(added),
      removed: removed === "-" ? 0 : Number(removed),
    });
  }
  return out;
}

/**
 * Run `tasks` with at most `limit` in flight, discarding the results.
 *
 * A bounded pool rather than `Promise.all` because the tasks here are child
 * processes: the whole point of measuring untracked files is that it costs a
 * spawn each, and sixty-four spawns at once on an operator's laptop is a
 * worse neighbour than the blocking read this replaced.
 */
async function pooled(
  tasks: readonly (() => Promise<void>)[],
  limit: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task === undefined) return;
      await task();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
}

/**
 * Lines in one untracked file, measured by diffing it against nothing.
 *
 * `--no-index` puts git in plain-diff mode, where it compares two paths on
 * disk rather than anything the repository knows about, so an untracked file
 * has an answer after all. It exits 1 when the inputs differ, which is
 * always here, hence the widened `okStatus`. A binary file answers `-` for
 * both counts and parses to zero, the same as it does in every other diff
 * this module reads.
 *
 * `/dev/null` is the empty side. A host without it (or a path git refuses)
 * returns undefined, and the caller leaves the count as it was.
 */
async function untrackedLineCount(
  exec: ExecAsync,
  cwd: string,
  absolutePath: string,
): Promise<number | undefined> {
  const stdout = await git(
    exec,
    cwd,
    ["diff", "--numstat", "--no-index", "-z", "--", "/dev/null", absolutePath],
    [0, 1],
  );
  if (stdout === undefined) return undefined;
  for (const value of parseNumstat(stdout).values()) return value.added;
  return undefined;
}

/**
 * Whether `HEAD` is a branch that has no commit yet, proven rather than
 * assumed. A failed diff is not proof of an unborn repository: a timeout or
 * a killed process fails the same way. Only a symbolic HEAD whose branch
 * does not exist can be compared with the empty tree.
 */
async function provenUnborn(exec: ExecAsync, cwd: string): Promise<boolean> {
  if ((await git(exec, cwd, ["rev-parse", "--verify", "HEAD"])) !== undefined)
    return false;
  const symbolic = firstLine(
    await git(exec, cwd, ["symbolic-ref", "-q", "HEAD"]),
  );
  if (symbolic === undefined) return false;
  const absent = await git(
    exec,
    cwd,
    ["show-ref", "--verify", "--quiet", symbolic],
    [1],
  );
  return absent !== undefined;
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
 * diff, and names the empty tree in its place.
 *
 * The status listing gates everything else, so it is read on its own. The
 * numstat and the repository root are then read together: they answer
 * unrelated questions about the same worktree, both are reads, and
 * `--no-optional-locks` keeps both off the index lock. The untracked probes
 * come last because they need the root to build an absolute path.
 *
 * With a baseline this is the measure ADR-186 replaced: every change since
 * that commit, which counts a pull's files and edits that predate the
 * session. The daemon reads through `readSessionChanges`, which keeps this
 * measure only for a session restored from a state file older than that
 * rule.
 */
export async function readWorkingTreeChanges(
  exec: ExecAsync,
  cwd: string,
  baseline?: string,
): Promise<GitWorkingTreeChange[] | undefined> {
  const status = await git(exec, cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    // Default `normal` mode collapses a new directory into one `?? dir/`
    // entry, so an agent that created a directory of files had all of them
    // recorded as a single synthetic path with zero lines. `all` names each
    // file, which is what the run is supposed to show. Both bounds still
    // apply above it: `parsePorcelainZ` stops at `MAX_CHANGED_PATHS`, and
    // only `MAX_UNTRACKED_LINE_COUNTS` of the untracked files are probed.
    "--untracked-files=all",
  ]);
  // Undefined is a read that did not happen: a timeout, a non-zero exit, a
  // directory that is not a repository. An empty list is a read that did
  // happen and found nothing. Collapsing the two would seal
  // `observed_changes: []` with `observed_changes_truncated: false`, which
  // states that git looked and the worktree was clean. Nothing looked. This
  // is the same distinction the module header draws for `dirty`, where a
  // failed `status` leaves the field off rather than asserting cleanliness,
  // and it matters more here because the caller seals a frame from it.
  if (status === undefined) return undefined;
  const worktree = parsePorcelainZ(status);
  // Against a baseline, the question is what this session changed, and work it
  // committed is no longer in `status` at all: the tree is clean and `HEAD` has
  // moved. Comparing the worktree with the current `HEAD` answers a different
  // question — what is uncommitted now — and a run that committed its work
  // recorded none of it. So the tracked half comes from a diff against the
  // commit the session started on, which covers committed and uncommitted
  // alike, and only the untracked half still comes from `status`, because an
  // untracked file is in no diff.
  const tracked =
    baseline === undefined
      ? undefined
      : await git(exec, cwd, ["diff", "--name-status", "-z", baseline]).then(
          (out) => (out === undefined ? undefined : parseNameStatusZ(out)),
        );
  // A missing baseline is unknown. Substituting today's HEAD would measure
  // a different interval and silently erase work the session committed.
  if (baseline !== undefined && tracked === undefined) return undefined;
  const ref = baseline ?? "HEAD";
  const entries =
    tracked === undefined
      ? worktree
      : [
          ...tracked,
          ...worktree.filter(
            (entry) =>
              entry.code === "??" &&
              !tracked.some((t) => t.path === entry.path),
          ),
        ];
  if (entries.length === 0) return [];
  const [numstatOut, root] = await Promise.all([
    git(exec, cwd, ["diff", "--numstat", ref, "-z"]).then(async (head) => {
      if (head !== undefined) return head;
      if (ref !== "HEAD") return undefined;
      if (!(await provenUnborn(exec, cwd))) return undefined;
      return git(exec, cwd, ["diff", "--numstat", EMPTY_TREE_OBJECT, "-z"]);
    }),
    git(exec, cwd, ["rev-parse", "--show-toplevel"]).then(firstLine),
  ]);
  if (numstatOut === undefined) return undefined;
  const counts = parseNumstat(numstatOut);
  if (root !== undefined)
    await countUntracked(exec, cwd, root, entries, counts);
  return rowsOf(entries, counts, root);
}

/**
 * The reported rows for these entries: absolute paths where the root is
 * known, counts where a diff or a probe gave one, and no row for a path
 * whose code says it holds what `HEAD` holds.
 */
function rowsOf(
  entries: readonly { code: string; path: string }[],
  counts: ReadonlyMap<string, { added: number; removed: number }>,
  root: string | undefined,
): GitWorkingTreeChange[] {
  const out: GitWorkingTreeChange[] = [];
  for (const entry of entries) {
    const status = statusOf(entry.code);
    if (status === undefined) continue;
    const count = counts.get(entry.path);
    out.push({
      path: absoluteIn(root, entry.path),
      repo_relative_path: root === undefined ? "" : entry.path,
      status,
      lines_added: count?.added ?? 0,
      lines_removed: count?.removed ?? 0,
    });
  }
  return out;
}

function absoluteIn(root: string | undefined, repoRelative: string): string {
  return root === undefined
    ? repoRelative
    : `${root.replace(/\/$/, "")}/${repoRelative}`;
}

/**
 * Measure the untracked files in `entries` that no diff counted, in path
 * order so the same ones are measured on every pass, and write their counts
 * into `counts`. A directory entry is left out because it names a subtree
 * and not a file.
 */
async function countUntracked(
  exec: ExecAsync,
  cwd: string,
  root: string,
  entries: readonly { code: string; path: string }[],
  counts: Map<string, { added: number; removed: number }>,
): Promise<void> {
  const untracked = entries
    // `??` and nothing else. A tracked path missing from the numstat is a
    // change git reported no line count for (a mode change, for one), and
    // diffing it against nothing would count the whole file as added.
    .filter((entry) => entry.code === "??")
    .map((entry) => entry.path)
    .filter(
      (repoRelative) =>
        !repoRelative.endsWith("/") && !counts.has(repoRelative),
    )
    .sort()
    .slice(0, MAX_UNTRACKED_LINE_COUNTS);
  await pooled(
    untracked.map((repoRelative) => async () => {
      const added = await untrackedLineCount(
        exec,
        cwd,
        absoluteIn(root, repoRelative),
      );
      if (added !== undefined) counts.set(repoRelative, { added, removed: 0 });
    }),
    UNTRACKED_COUNT_CONCURRENCY,
  );
}

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

/**
 * The body of one `oxagen:worktree_reconciled` frame.
 *
 * The list is sorted by repo-relative path and then cut to
 * `MAX_OBSERVED_CHANGES`, so the cut is the same every time rather than
 * whatever order git happened to list the tree in, and a consumer comparing
 * two frames is comparing like with like. What was cut is stated:
 * `observed_changes_total` is how many paths were seen and
 * `observed_changes_truncated` says the list below it is not all of them. A
 * truncated record that did not say so would read as a complete one.
 *
 * `observed_changes_total` is itself a floor when the reader's own
 * `MAX_CHANGED_PATHS` bound was reached, because git's output was cut before
 * this function ever saw it.
 */
export function worktreeReconciledBody(
  changes: readonly GitWorkingTreeChange[],
): Record<string, unknown> {
  const sorted = [...changes].sort((a, b) =>
    a.repo_relative_path < b.repo_relative_path
      ? -1
      : a.repo_relative_path > b.repo_relative_path
        ? 1
        : 0,
  );
  return {
    observed_changes: sorted.slice(0, MAX_OBSERVED_CHANGES),
    observed_changes_total: sorted.length,
    observed_changes_truncated: sorted.length > MAX_OBSERVED_CHANGES,
  };
}
