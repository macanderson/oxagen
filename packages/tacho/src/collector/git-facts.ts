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
 * on the same event loop a synchronous spawn would stop. Reads that do not
 * depend on each other are issued together, which is safe because they are
 * all reads and `--no-optional-locks` keeps every one of them off the index
 * lock, so two concurrent git processes in one worktree contend for nothing
 * and neither can disturb the agent working there.
 */
import { digestBytes, type Sha256Digest } from "../digest";
import { MAX_OBSERVED_CHANGES } from "../envelope";
import type { ExecAsync, ExecResult } from "../host/service";

/** Repository facts for one working directory, all optional. */
export interface GitFacts {
  head_sha?: string;
  branch?: string;
  dirty?: boolean;
  remote_digest?: Sha256Digest;
  /**
   * The worktree's top directory (`rev-parse --show-toplevel`). It names the
   * repository a session's baseline belongs to, so two directories of one
   * repository share one baseline. Local only: it is never sealed.
   */
  repo_root?: string;
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
 * Head, branch, dirtiness, the digested remote and the repository root for
 * one working directory.
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
  // `HEAD` gates the other four: a directory that cannot answer it is not a
  // repository, and there is nothing to ask it. The four that follow answer
  // independent questions, so they are asked at once rather than in series.
  const [branch, status, remote, root] = await Promise.all([
    git(exec, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then(firstLine),
    git(exec, cwd, ["status", "--porcelain"]),
    git(exec, cwd, ["remote", "get-url", "origin"]).then(firstLine),
    git(exec, cwd, ["rev-parse", "--show-toplevel"]).then(firstLine),
  ]);
  // `HEAD` is what a detached checkout answers, and it names no branch.
  if (branch !== undefined && branch !== "HEAD") facts.branch = branch;
  // Undefined here is a failed read, not a clean tree, so the field is left
  // off rather than asserting cleanliness nobody observed.
  if (status !== undefined) facts.dirty = status.trim().length > 0;
  if (remote !== undefined)
    facts.remote_digest = digestBytes(canonicalRemote(remote));
  if (root !== undefined) facts.repo_root = root;
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
 * So the userinfo goes, the scheme and the `.git` suffix go, `scp` syntax
 * (`git@host:acme/repo.git`) is folded onto the same shape as its URL form,
 * and the host is lowercased. The path is not, because a repository name is
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
  // Trailing slashes first: the `.git` anchor does not match with one after
  // it, so the other order left `repo.git/` carrying its suffix.
  value = value.replace(/\/+$/, "").replace(/\.git$/, "");
  const slash = value.indexOf("/");
  if (slash === -1) return value.toLowerCase();
  return `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
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
      // A failed diff is not proof of an unborn repository. Only a symbolic
      // HEAD whose branch does not exist can be compared with the empty tree.
      if (
        (await git(exec, cwd, ["rev-parse", "--verify", "HEAD"])) !== undefined
      )
        return undefined;
      const symbolic = firstLine(
        await git(exec, cwd, ["symbolic-ref", "-q", "HEAD"]),
      );
      if (symbolic === undefined) return undefined;
      const absent = await git(
        exec,
        cwd,
        ["show-ref", "--verify", "--quiet", symbolic],
        [1],
      );
      if (absent === undefined) return undefined;
      return git(exec, cwd, ["diff", "--numstat", EMPTY_TREE_OBJECT, "-z"]);
    }),
    git(exec, cwd, ["rev-parse", "--show-toplevel"]).then(firstLine),
  ]);
  if (numstatOut === undefined) return undefined;
  const counts = parseNumstat(numstatOut);
  const absolute = (repoRelative: string): string =>
    root === undefined
      ? repoRelative
      : `${root.replace(/\/$/, "")}/${repoRelative}`;

  // Untracked files, in path order so the same ones are measured on every
  // pass rather than whichever order git happened to list the tree in, and a
  // directory entry left out because it names a subtree and not a file.
  if (root !== undefined) {
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
          absolute(repoRelative),
        );
        if (added !== undefined)
          counts.set(repoRelative, { added, removed: 0 });
      }),
      UNTRACKED_COUNT_CONCURRENCY,
    );
  }

  return entries.map((entry) => {
    const repoRelative = entry.path;
    const count = counts.get(repoRelative);
    return {
      path: absolute(repoRelative),
      repo_relative_path: root === undefined ? "" : repoRelative,
      status: statusOf(entry.code),
      lines_added: count?.added ?? 0,
      lines_removed: count?.removed ?? 0,
    };
  });
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
