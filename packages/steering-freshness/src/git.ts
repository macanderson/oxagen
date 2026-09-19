/**
 * git.ts — the only place this package shells out.
 *
 * Every question steering freshness asks is a question git already answers,
 * so nothing here parses a record, hashes a file, or talks to the platform.
 * That is deliberate: the governed files are versioned by git (ADR-061 — a
 * Context PR merges `.oxagen/rules/<lineage>.toml` onto the production
 * branch), so git's own merge-base arithmetic *is* the definition of "a
 * Context PR merged that this checkout does not have". Re-deriving it from
 * file hashes would be a second, weaker copy of the same answer.
 *
 * The runner is injected so the callers above can be tested against a table
 * of git outputs, and so a host that already has a git abstraction (the
 * desktop app, a CI runner) can supply its own without this package spawning
 * processes behind its back.
 */
import { execFile } from "node:child_process";

/** One git invocation: argv in, stdout out. Rejects on a non-zero exit. */
export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<string>;

/** A git call that failed, carrying enough to explain itself in a banner. */
export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    /**
     * The signal that killed the command, when one did. A timeout is a
     * SIGTERM from `execFile`, and it is the difference between "git
     * answered no" and "git never answered": a probe whose command was
     * killed has to stay unknown, or a slow disk reads as a missing object.
     */
    readonly signal: string | null = null,
  ) {
    super(
      `git ${args.join(" ")} failed (exit ${exitCode ?? signal ?? "signal"}): ${stderr.trim()}`,
    );
    this.name = "GitCommandError";
  }
}

/**
 * What a failed probe means: git said no, or git said nothing.
 *
 * `cat-file -e` and its kin answer a yes/no question by exit status, so a
 * caller that reads every failure as "no" turns a timeout into a fact. The
 * three cases have to stay apart, because the verdict they feed is the one
 * that refuses a prompt.
 *
 *   - `"absent"`: git ran, and the object is not there. Exit 1 is the
 *     documented answer for a plain object id; exit 128 with a
 *     "not a valid object name" is the answer for `<sha>^{commit}`, which is
 *     how every probe here asks (git resolves the peel before it looks).
 *   - `"unanswered"`: the command was killed by the hook deadline or a
 *     signal, it exited on something else (a corrupt object database prints
 *     its own fatal), or the injected runner failed in a way this package
 *     cannot read. No fact was established.
 */
export type ProbeFailure = "absent" | "unanswered";

/** Ordinary git ways of saying "that name resolves to nothing here". */
const ABSENT_STDERR =
  /not a valid object name|bad object|unknown revision|no such (?:object|ref)|could not get object info/i;

/**
 * Read a failed probe as "absent" or "unanswered", erring towards
 * unanswered: an unknown verdict warns and lets the prompt run, while a
 * wrong "absent" refuses one.
 */
export function classifyProbeFailure(err: unknown): ProbeFailure {
  if (!(err instanceof GitCommandError)) return "unanswered";
  // Killed, so it never got to answer. The hook deadline lands here.
  if (err.signal !== null || err.exitCode === null) return "unanswered";
  if (err.exitCode === 1) return "absent";
  return ABSENT_STDERR.test(err.stderr) ? "absent" : "unanswered";
}

/**
 * Does this clone hold `rev` as a commit?
 *
 * Three answers, and the third is the point: `true` present, `false` git
 * looked and it is not here, `null` git could not say. A `gitOrNull` probe
 * collapsed the last two, so a `cat-file` that timed out on its slice of the
 * hook budget reported the publication commit absent, the platform fallback
 * read that as `behind`, and an enabled blocking policy refused the prompt
 * over a local git timeout.
 */
export async function commitPresent(
  ctx: GitContext,
  rev: string,
): Promise<boolean | null> {
  try {
    await ctx.run(["cat-file", "-e", `${rev}^{commit}`], {
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
    });
    return true;
  } catch (err) {
    return classifyProbeFailure(err) === "absent" ? false : null;
  }
}

/**
 * The default runner. `execFile`, never a shell: a branch name is
 * caller-influenced (it can come out of `.oxagen/settings.json`) and must
 * never reach a shell where `;` or a backtick would mean something.
 */
export const execGit: GitRunner = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        // A rules directory is small; 8 MiB is well past any real listing and
        // still bounded, so a pathological repo cannot exhaust memory here.
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          // Never let git stop for a passphrase or a credential prompt: this
          // runs inside someone's prompt submission, where a hung fetch is
          // indistinguishable from a hung agent.
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code =
            typeof (err as NodeJS.ErrnoException & { code?: unknown }).code ===
            "number"
              ? ((err as unknown as { code: number }).code satisfies number)
              : null;
          const signal =
            typeof (err as NodeJS.ErrnoException & { signal?: unknown })
              .signal === "string"
              ? ((err as unknown as { signal: string }).signal satisfies string)
              : null;
          reject(
            new GitCommandError(args, code, stderr || err.message, signal),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface GitContext {
  /** Any directory inside the repository. */
  cwd: string;
  run: GitRunner;
  timeoutMs: number;
}

/** Run git and return trimmed stdout. */
export async function git(
  ctx: GitContext,
  ...args: readonly string[]
): Promise<string> {
  const out = await ctx.run(args, { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs });
  return out.trim();
}

/**
 * `base`, with every call's timeout clamped to what is left of `deadline` at
 * the moment the call is made, floored at `floorMs`.
 *
 * Shared by every caller that makes more than one git call in sequence
 * against a budget owned by someone above it (the installed hook's own
 * timeout): a per-call `timeoutMs` alone lets each call in the sequence
 * spend the whole remainder, so several slow calls together outlive the
 * caller's real deadline. The clamp lives on the runner, not on `timeoutMs`
 * at construction, so a context handed to a function that makes several
 * calls back to back still narrows on every one of them.
 */
export function clampContextToDeadline(
  base: GitContext,
  deadline: number,
  floorMs: number,
  now: () => number = Date.now,
): GitContext {
  return {
    ...base,
    run: (args, o) =>
      base.run(args, {
        ...o,
        timeoutMs: Math.max(floorMs, Math.min(o.timeoutMs, deadline - now())),
      }),
  };
}

/** Run git, returning null instead of throwing. For questions with a "no" answer. */
export async function gitOrNull(
  ctx: GitContext,
  ...args: readonly string[]
): Promise<string | null> {
  try {
    return await git(ctx, ...args);
  } catch {
    return null;
  }
}

/** The repository's working-tree root, or null when cwd is not in a repository. */
export async function repoRoot(ctx: GitContext): Promise<string | null> {
  return gitOrNull(ctx, "rev-parse", "--show-toplevel");
}

/**
 * Resolve the remote's default branch — the production branch a Context PR
 * targets.
 *
 * Three sources, in descending order of how much they can be trusted to be
 * current:
 *
 *   1. `refs/remotes/<remote>/HEAD`, written by clone and by
 *      `git remote set-head`. Cheap and local, but it is a *cached* answer
 *      and goes stale if the repository's default branch is renamed.
 *   2. `git remote show <remote>`, which asks the server. Correct, but it is
 *      a network round trip, so it is only reached when (1) is absent.
 *   3. The conventional names, probed as remote-tracking refs.
 *
 * Returns null when none of the three answers, which the caller reports as
 * `unknown` rather than guessing "main" — silently checking the wrong branch
 * would produce a confident, wrong verdict, and a confident wrong verdict is
 * worse here than no verdict.
 */
export async function defaultBranch(
  ctx: GitContext,
  remote: string,
  {
    allowNetwork,
    refreshCachedHead = allowNetwork,
  }: { allowNetwork: boolean; refreshCachedHead?: boolean },
): Promise<string | null> {
  // The cached ref answers first because it is local and free — but only
  // after it has been given the chance to be right. `refs/remotes/<remote>/HEAD`
  // is written once by clone and never again, so a repository whose default
  // branch is renamed keeps pointing at the old one indefinitely, and reading
  // it straight would have this checker fetch and compare a branch that is no
  // longer production. Every steering change on the new branch would be
  // invisible, confidently.
  //
  // `remote set-head --auto` is the operation that reconciles the cache with
  // the server, so when networking is allowed it runs first and the read below
  // is then reading a fresh answer rather than a remembered one. It is the
  // same single round trip `git remote show` would cost, and it leaves the
  // repository better than it found it, so the next offline run is right too.
  // A failure is ignored: offline, or a remote that will not answer, is
  // exactly the case the cached ref exists to cover.
  // Throttled by the caller. This is a network round trip, and it happens
  // before the fetch throttle that is supposed to bound how often a prompt
  // talks to a server, so running it unconditionally made that interval
  // bound nothing and let an unreachable remote spend the whole git timeout
  // ahead of every prompt. Default is the old behaviour, for callers with no
  // throttle of their own.
  if (refreshCachedHead) {
    await gitOrNull(ctx, "remote", "set-head", remote, "--auto");
  }
  const head = await gitOrNull(
    ctx,
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  );
  // "origin/main" → "main". A branch name may itself contain "/", so only the
  // first segment (the remote name) is removed.
  if (head?.startsWith(`${remote}/`)) return head.slice(remote.length + 1);

  if (allowNetwork) {
    const shown = await gitOrNull(ctx, "remote", "show", remote);
    const match = shown?.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
    const named = match?.[1];
    if (named && named !== "(unknown)") return named;
  }

  for (const candidate of ["main", "master", "trunk"]) {
    const exists = await gitOrNull(
      ctx,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/${remote}/${candidate}`,
    );
    if (exists) return candidate;
  }
  return null;
}

/**
 * Fetch just the branch we compare against.
 *
 * Returns whether it succeeded; a failure is never fatal. This runs on the
 * path of someone's prompt, often on a laptop that is offline, on a VPN that
 * is half up, or behind a credential helper that would like to ask a
 * question. In all three the honest outcome is "I could not reach the
 * remote", reported next to a verdict computed from whatever ref is already
 * on disk — not a blocked prompt and not a thrown error.
 */
export async function fetchBranch(
  ctx: GitContext,
  remote: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await git(
      ctx,
      "fetch",
      "--quiet",
      "--no-tags",
      // Nothing here reads history, only the tip's tree, so a shallow fetch
      // is enough on a repository that is already shallow and harmless on one
      // that is not.
      "--no-write-fetch-head",
      // End of options. The callers validate `remote` and `branch` first
      // (`isSafeRefName`, `configuredRemotes`); this is the belt to that
      // brace, so a name that slipped through is read as a repository, never
      // as an option.
      "--",
      remote,
      `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Whether `name` is safe to hand to git as a remote or branch name.
 *
 * Both values can come from `.oxagen/settings.json`, which is committed to the
 * repository and therefore controlled by whoever wrote the checkout. Git reads
 * an argument that starts with `-` as an option, and `git fetch` has options
 * that run programs: `remote: "--upload-pack=<command>"` executed that command
 * the moment `steering status` or the prompt gate ran. So a name is refused
 * unless it is a plain ref component: no leading `-`, no whitespace or control
 * characters, no `..`, and only the characters git itself allows in a ref.
 *
 * This is the first of two guards. The second is `configuredRemotes`: a remote
 * must also be one this repository actually has, which no settings file can
 * invent.
 */
export function isSafeRefName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/"))
    return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{"))
    return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name);
}

/** The remotes this repository has configured, from `git remote`. */
export async function configuredRemotes(ctx: GitContext): Promise<string[]> {
  const out = await gitOrNull(ctx, "remote");
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Is this a shallow clone? (`--show-toplevel` answered, so `--is-shallow-repository` will too.) */
export async function isShallow(ctx: GitContext): Promise<boolean> {
  return (
    (await gitOrNull(ctx, "rev-parse", "--is-shallow-repository")) === "true"
  );
}

/**
 * Deepen a shallow clone's history by `by` commits, on every ref `remote`
 * has. HEAD's own history is the shallow side, and HEAD may be on any branch,
 * so the fetch names no branch; git deepens what the clone already tracks.
 * True if the fetch succeeded, whether or not it reached full depth.
 */
export async function deepen(
  ctx: GitContext,
  remote: string,
  by: number,
): Promise<boolean> {
  return (
    (await gitOrNull(
      ctx,
      "fetch",
      "--quiet",
      "--no-tags",
      `--deepen=${by}`,
      "--",
      remote,
    )) !== null
  );
}

/**
 * Index entries under the pathspec that git has deliberately left OUT of the
 * working tree: a sparse checkout, or `update-index --skip-worktree`. The
 * entry is in the index, so every diff against a commit reads it as present
 * and unchanged, and `status` says nothing, while the file is not on disk.
 * `ls-files -t` marks such an entry `S`.
 *
 * A failure here throws. This probe is the only check that sees a governed
 * file a sparse checkout left off disk; answering "none" on a timeout or a
 * corrupt index let the verdict read `current` with those records absent,
 * so the caller's comparison guard turns the failure into `unknown` and
 * says why.
 */
export async function skipWorktreePaths(
  ctx: GitContext,
  pathspecs: readonly string[],
): Promise<string[]> {
  const raw = await git(ctx, "ls-files", "-t", "-z", "--", ...pathspecs);
  if (!raw) return [];
  const out: string[] = [];
  for (const entry of raw.split("\0")) {
    if (entry.startsWith("S ")) out.push(entry.slice(2));
  }
  return out;
}

/**
 * `path → blob oid` for each of `paths` that exists in the tree of `rev`.
 * Batched so a very large rules directory cannot overrun the argv limit.
 */
export async function treeBlobs(
  ctx: GitContext,
  rev: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    const raw = await git(ctx, "ls-tree", "-r", "-z", rev, "--", ...batch);
    // `<mode> <type> <oid>\t<path>`
    for (const entry of raw.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [, type, oid] = entry.slice(0, tab).split(" ");
      if (type === "blob" && oid) out.set(entry.slice(tab + 1), oid);
    }
  }
  return out;
}

/**
 * Which of `paths` exist as blobs in the tree of `rev`, in the order asked.
 * A skip-worktree entry is only worth restoring from production if
 * production has it; one that exists only in this index (a staged addition
 * under skip-worktree) would make `restore --source=<rev>` fail on a
 * pathspec the source lacks.
 */
export async function pathsInTree(
  ctx: GitContext,
  rev: string,
  paths: readonly string[],
): Promise<string[]> {
  const present = await treeBlobs(ctx, rev, paths);
  return paths.filter((path) => present.has(path));
}

/**
 * `path → blob oid` for each of `paths` as the INDEX holds it. Null for a
 * path the index does not have. Batched like the others.
 */
export async function indexBlobs(
  ctx: GitContext,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    const raw = await git(ctx, "ls-files", "-s", "-z", "--", ...batch);
    // `<mode> <oid> <stage>\t<path>`
    for (const entry of raw.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [, oid] = entry.slice(0, tab).split(" ");
      if (oid) out.set(entry.slice(tab + 1), oid);
    }
  }
  return out;
}

/**
 * `path → blob oid` for each of `paths` as the WORKING COPY holds it: the
 * object id git would store for the file on disk, filters applied. Every
 * path must exist on disk; `hash-object` fails on one that does not.
 *
 * This is the only content read this package makes, and it is here because
 * a `skip-worktree` entry is the one file git will not compare for us:
 * `diff` and `status` both read the index in its place, so an edit to the
 * file on disk is invisible to every other question this package asks.
 */
export async function workingBlobs(
  ctx: GitContext,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    const raw = await git(ctx, "hash-object", "--", ...batch);
    const oids = raw.split("\n").filter((line) => line.length > 0);
    batch.forEach((path, j) => {
      const oid = oids[j];
      if (oid) out.set(path, oid);
    });
  }
  return out;
}

/** Does this ref resolve? */
export async function revParse(
  ctx: GitContext,
  rev: string,
): Promise<string | null> {
  return gitOrNull(ctx, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
}

/**
 * The tree object id of `<rev>:<path>`, which is a content fingerprint of the
 * whole directory for free — two checkouts with the same tree oid hold byte
 * identical governed files. Null when the path does not exist at that rev.
 */
export async function treeOid(
  ctx: GitContext,
  rev: string,
  path: string,
): Promise<string | null> {
  return gitOrNull(ctx, "rev-parse", `${rev}:${path}`);
}

/**
 * Whether `ancestor` is reachable from `descendant`.
 *
 * Three answers, because the caller acts on each differently:
 *
 *   - `true`: reachable.
 *   - `false`: not reachable. That includes git looking for `ancestor` and
 *     finding it absent from this clone, since a ref cannot contain a commit
 *     the clone lacks.
 *   - `null`: git failed to answer (a timeout, a signal, a corrupt object
 *     database), on either the presence probe or the reachability call. A
 *     caller must not read that as "no".
 */
export async function isAncestor(
  ctx: GitContext,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  // Three answers, not two. `commitPresent` tells "git looked and it is not
  // here" apart from "git never answered", because this probe runs on a slice
  // of the hook deadline and a slice can run out.
  const present = await commitPresent(ctx, ancestor);
  if (present === null) return null;
  if (!present) return false;
  try {
    await ctx.run(["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
    });
    return true;
  } catch (err) {
    // Exit 1 is git's documented "not an ancestor", and only that is "no".
    // Anything else (a timeout, a signal, a corrupt object database) means
    // the question went unanswered, which is the null this function promises.
    // Reading every failure as "no" made a plumbing error look like
    // platform-only staleness, and the gate blocked the prompt over it.
    if (err instanceof GitCommandError && err.exitCode === 1) return false;
    return null;
  }
}

/** The best common ancestor of two commits, or null when they share none. */
export async function mergeBase(
  ctx: GitContext,
  a: string,
  b: string,
): Promise<string | null> {
  return gitOrNull(ctx, "merge-base", a, b);
}

/** One path's fate between two commits. */
export interface PathChange {
  status: "added" | "modified" | "removed" | "renamed" | "other";
  path: string;
}

const STATUS_NAMES: Record<string, PathChange["status"]> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "added",
  T: "modified",
};

/**
 * Parse `git diff --name-status -z`.
 *
 * The NUL-delimited form is the only safe one here: a path under `.oxagen/`
 * is author-supplied (a lineage id becomes a file stem) and the
 * line-delimited form would mis-split a path containing a newline. A rename
 * or copy entry carries a similarity score and TWO paths; the destination is
 * the one that matters.
 */
export function parseNameStatus(raw: string): PathChange[] {
  const fields = raw.split("\0");
  const out: PathChange[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i];
    if (!code) continue;
    const letter = code[0]!;
    const status = STATUS_NAMES[letter] ?? "other";
    const advance = letter === "R" || letter === "C" ? 2 : 1;
    const path = fields[i + advance];
    i += advance;
    if (path) out.push({ status, path });
  }
  return out;
}

/**
 * `git diff --name-status` between two commits, limited to the pathspecs.
 *
 * The first pathspec must be a positive one: git only honours `:(exclude)`
 * magic alongside at least one path it is subtracting from.
 *
 * `--no-renames` is deliberate. A record's file stem is its lineage id, so a
 * rename in `.oxagen/rules/` is a lineage change, not a move — and the
 * add/delete pair is both the truer description and the one a sync can apply
 * directly, because a rename entry names a destination without saying the
 * source must be removed. The parser still handles R and C for any caller
 * that turns rename detection back on.
 */
export async function diffPaths(
  ctx: GitContext,
  from: string,
  to: string,
  pathspecs: readonly string[],
): Promise<PathChange[]> {
  const raw = await ctx.run(
    [
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      from,
      to,
      "--",
      ...pathspecs,
    ],
    { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs },
  );
  return parseNameStatus(raw);
}

/** Commits on `to` but not `from` that touched the pathspec. */
export async function commitsTouching(
  ctx: GitContext,
  from: string,
  to: string,
  pathspec: string,
): Promise<number> {
  const raw = await gitOrNull(
    ctx,
    "rev-list",
    "--count",
    `${from}..${to}`,
    "--",
    pathspec,
  );
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Working-copy paths under the pathspec that differ from HEAD — modified,
 * staged, or untracked-and-not-ignored.
 *
 * This is the "is it safe to overwrite `.oxagen/`?" question, and it is
 * deliberately answered over the *whole* directory rather than only the files
 * the remote changed. A sync writes a directory; a dirty file it happens not
 * to touch this time is still unreviewed work sitting in the blast radius.
 */
export async function dirtyPaths(
  ctx: GitContext,
  pathspecs: readonly string[],
): Promise<string[]> {
  const raw = await ctx.run(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // Ignored files too. This is the "is it safe to overwrite `.oxagen/`?"
      // question, and a file excluded through `.gitignore` or
      // `.git/info/exclude` is still a file the sync's `restore --worktree`
      // would replace. Without this a locally ignored copy at a path
      // production just added read as no dirt at all, and auto-sync wrote
      // over it with `force` false.
      "--ignored=matching",
      "--",
      ...pathspecs,
    ],
    { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs },
  );
  return parsePorcelain(raw);
}

/** Parse `git status --porcelain=v1 -z` into the paths it names. */
export function parsePorcelain(raw: string): string[] {
  const out: string[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    // "XY <path>" — two status columns, a space, then the path.
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    out.push(entry.slice(3));
    // A rename or copy entry is followed by its original path in the next
    // field, which is not itself a dirty path.
    if (xy.includes("R") || xy.includes("C")) i += 1;
  }
  return out;
}
