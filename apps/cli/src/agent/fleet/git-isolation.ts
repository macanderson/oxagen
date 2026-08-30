/**
 * Git isolation protocol for the fleet — the safety layer that makes it
 * *physically impossible* for two parallel subagents to clobber each other's
 * files, and that makes it *impossible to lose* any work an agent committed.
 *
 * The original fleet ran every subagent against one shared working tree and
 * tried to avoid collisions with a guess: tasks whose *predicted* `files[]`
 * overlapped were serialized. That guess fails the moment an agent edits a file
 * it didn't predict — two writes interleave and you get a half-written file,
 * before any commit exists to recover from. The fix is not "commit more
 * cleverly", it's isolation: give each agent its own checkout.
 *
 * The model (a correct, minimal version of "branch-per-change, replay-on-merge"):
 *
 *   1. SPAWN   — each task gets its own `git worktree` on its own branch, cut
 *                from a single frozen base ref. Separate index, separate HEAD,
 *                separate files: file-level clobbering is now structurally
 *                impossible, not merely discouraged.
 *   2. CHECKPOINT — the agent's changes are committed atomically, and every
 *                commit hash is pinned under `refs/oxagen/agents/<task>/<n>`.
 *                A pinned commit is content-addressed and immune to branch
 *                deletion and `git gc`: work can be orphaned but never lost.
 *   3. INTEGRATE — task branches are merged back into one integration branch
 *                *one at a time* (a mutex), with `rerere` enabled. A merge that
 *                conflicts is **aborted**, leaving the integration tree clean,
 *                and the conflict is *surfaced* (the files are returned) instead
 *                of silently corrupting anything. Conflicts are relocated to an
 *                explicit, owned step — they are not made to disappear, because
 *                for *code* that is impossible in general (two semantically
 *                contradictory edits can't both be right).
 *   4. DISPOSE  — worktrees and branches are torn down, but the
 *                `refs/oxagen/agents/*` pins are kept. `git for-each-ref
 *                refs/oxagen/agents` is then a durable log of every atomic
 *                change the fleet ever made, recoverable by hash.
 *
 * Git is shelled via {@link GitRunner} (injectable) so the orchestrator's unit
 * tests stay filesystem-free; the real runner uses `node:child_process`,
 * matching the rest of the CLI (no git library dependency).
 */
import { execFile } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** Result of one git invocation. Never throws — the exit code is returned. */
export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs git with the given args in `cwd`. Injectable for tests. */
export type GitRunner = (args: string[], cwd?: string) => Promise<GitResult>;

/** The real runner: `git <args>` via child_process, rooted at the repo. */
export function defaultGitRunner(repoRoot: string): GitRunner {
  return async (args, cwd) => {
    try {
      const { stdout, stderr } = await pexec("git", args, {
        cwd: cwd ?? repoRoot,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0 };
    } catch (e) {
      const err = e as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        message?: string;
      };
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "",
        code: typeof err.code === "number" ? err.code : 1,
      };
    }
  };
}

/**
 * True when `cwd` is inside a git working tree. Isolation now defaults on
 * (see {@link WorktreeManager}), so callers use this to fall back to the
 * shared-tree mode gracefully — a plain (non-git) directory should not make
 * every task fail at `spawn()` — rather than asserting a repo exists.
 */
export async function isGitRepo(
  cwd: string,
  git: GitRunner = defaultGitRunner(cwd),
): Promise<boolean> {
  const res = await git(["rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.stdout.trim() === "true";
}

/** Outcome of integrating one task branch into the integration branch. */
export interface IntegrationResult {
  /** True when the task branch merged cleanly (or had nothing new to merge). */
  ok: boolean;
  /** Integration branch tip after a clean merge. */
  commit?: string;
  /** Conflicting files (relative paths) when `ok` is false. */
  conflicts?: string[];
  /** The task branch that was being integrated. */
  taskBranch: string;
  /** The pinned task tip — always recoverable, even on conflict. */
  taskTip?: string;
  /** True when `rerere` auto-applied a previously-recorded resolution. */
  autoResolved?: boolean;
}

/** A pinned atomic commit produced by an agent. */
export interface Checkpoint {
  taskId: string;
  hash: string;
  /** Durable ref keeping the commit reachable forever. */
  ref: string;
  message: string;
}

/**
 * The isolation surface the fleet depends on. {@link WorktreeManager} is the
 * real implementation; tests inject a fake satisfying this interface so the
 * orchestrator's own unit tests never touch git or the filesystem.
 */
export interface Isolation {
  init(): Promise<void>;
  spawn(taskId: string): Promise<string>;
  checkpoint(taskId: string, message: string): Promise<Checkpoint | null>;
  recordedCommits(taskId: string): readonly Checkpoint[];
  integrate(taskId: string, message?: string): Promise<IntegrationResult>;
  integrationRef(): { path: string; branch: string } | null;
  dispose(taskId: string, opts?: { keep?: boolean }): Promise<void>;
  cleanupAll(): Promise<void>;
}

export interface WorktreeManagerOptions {
  /** Any path inside the repo; the real toplevel is resolved in {@link init}. */
  repoRoot: string;
  /** Ref namespace for this fleet run's branches/pins (e.g. the plan id). */
  namespace?: string;
  /** Where worktrees are created (default `<repo>/.oxagen/worktrees`). */
  root?: string;
  /** Inject a fake git for tests; defaults to {@link defaultGitRunner}. */
  git?: GitRunner;
}

/** Allowed characters in a branch/path segment derived from a task id. */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "task";
}

/**
 * Owns the worktrees, branches, and durability pins for one fleet run.
 *
 * One instance per {@link Fleet}. Methods are safe to call from many concurrent
 * agents: `spawn`/`checkpoint`/`dispose` operate on disjoint worktrees, and
 * `integrate` is serialized internally so two merges never race on the
 * integration branch.
 */
export class WorktreeManager implements Isolation {
  private readonly opts: WorktreeManagerOptions;
  private readonly git: GitRunner;
  private readonly ns: string;
  private repoRoot: string;
  private root: string;

  /** The frozen commit every task branch is cut from. */
  private baseRef = "";
  /** Lazily-created integration worktree path + branch. */
  private integration: { path: string; branch: string } | null = null;
  private initialized = false;

  /** Per-task pin sequence + recorded checkpoints (the durability log). */
  private readonly seq = new Map<string, number>();
  private readonly commits = new Map<string, Checkpoint[]>();
  /** Worktrees handed out, by task id. */
  private readonly worktrees = new Map<
    string,
    { path: string; branch: string }
  >();

  /** Serializes `integrate` so concurrent finishers can't race the merge. */
  private integrateLock: Promise<unknown> = Promise.resolve();

  constructor(opts: WorktreeManagerOptions) {
    this.opts = opts;
    this.git = opts.git ?? defaultGitRunner(opts.repoRoot);
    this.ns = safeSegment(opts.namespace ?? "fleet");
    this.repoRoot = opts.repoRoot;
    this.root = opts.root ?? join(opts.repoRoot, ".oxagen", "worktrees");
  }

  /**
   * Resolve the repo toplevel, freeze the base ref, enable `rerere`, and keep
   * the worktree root out of git's sight. Idempotent.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const top = await this.git(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      throw new Error(
        `git isolation: not a git repository (${top.stderr.trim()})`,
      );
    }
    this.repoRoot = top.stdout.trim();
    if (!this.opts.root)
      this.root = join(this.repoRoot, ".oxagen", "worktrees");

    const head = await this.git(["rev-parse", "HEAD"]);
    if (head.code !== 0)
      throw new Error(
        `git isolation: cannot resolve HEAD (${head.stderr.trim()})`,
      );
    this.baseRef = head.stdout.trim();

    // rerere makes repeated conflict resolutions idempotent — a resolver agent
    // (or human) resolves a given conflict once and git replays it thereafter.
    await this.git(["config", "rerere.enabled", "true"]);

    this.excludeWorktreeRoot();
    mkdirSync(this.root, { recursive: true });
    this.initialized = true;
  }

  /** The frozen base every task fans out from. */
  get base(): string {
    return this.baseRef;
  }

  /**
   * Create an isolated worktree for `taskId` and return its path. The agent runs
   * with this as its `cwd`; nothing it does can touch another agent's tree.
   */
  async spawn(taskId: string): Promise<string> {
    await this.init();
    const seg = safeSegment(taskId);
    const branch = `fleet/${this.ns}/t/${seg}`;
    const path = join(this.root, this.ns, `t-${seg}`);

    // A re-run may leave a stale worktree/branch behind; clear it first.
    await this.removeWorktree(path);
    await this.git(["branch", "-D", branch]); // ignore "not found"

    const add = await this.git([
      "worktree",
      "add",
      "-b",
      branch,
      path,
      this.baseRef,
    ]);
    if (add.code !== 0) {
      throw new Error(
        `git isolation: worktree add failed for ${taskId}: ${add.stderr.trim()}`,
      );
    }
    this.worktrees.set(taskId, { path, branch });
    return path;
  }

  /**
   * Atomically commit whatever the agent changed in its worktree and pin the
   * commit under `refs/oxagen/agents/<task>/<n>`. Returns the checkpoint, or
   * `null` when the agent changed nothing.
   */
  async checkpoint(
    taskId: string,
    message: string,
  ): Promise<Checkpoint | null> {
    const wt = this.worktrees.get(taskId);
    if (!wt)
      throw new Error(
        `git isolation: no worktree for ${taskId} (call spawn first)`,
      );

    await this.git(["add", "-A"], wt.path);
    const status = await this.git(["status", "--porcelain"], wt.path);
    if (status.code === 0 && status.stdout.trim() === "") return null; // nothing changed

    // --no-verify: these are fine-grained per-step commits; the gate runs at
    // integration / CI, not on every micro-commit.
    const commit = await this.git(
      ["commit", "--no-verify", "-m", message],
      wt.path,
    );
    if (commit.code !== 0) {
      throw new Error(
        `git isolation: commit failed for ${taskId}: ${commit.stderr.trim()}`,
      );
    }
    const rev = await this.git(["rev-parse", "HEAD"], wt.path);
    const hash = rev.stdout.trim();

    const n = (this.seq.get(taskId) ?? 0) + 1;
    this.seq.set(taskId, n);
    const ref = `refs/oxagen/agents/${safeSegment(taskId)}/${n}`;
    await this.git(["update-ref", ref, hash]); // pin: survives branch deletion + gc

    const cp: Checkpoint = { taskId, hash, ref, message };
    const list = this.commits.get(taskId) ?? [];
    list.push(cp);
    this.commits.set(taskId, list);
    return cp;
  }

  /** Every pinned checkpoint recorded for a task — the durability log. */
  recordedCommits(taskId: string): readonly Checkpoint[] {
    return this.commits.get(taskId) ?? [];
  }

  /**
   * Merge a task's branch into the integration branch. Serialized so two merges
   * never race. A conflicting merge is aborted (integration tree left clean) and
   * the conflicting files are returned — never a corrupt half-merge.
   */
  integrate(taskId: string, message?: string): Promise<IntegrationResult> {
    return this.withIntegrateLock(() => this.doIntegrate(taskId, message));
  }

  private async doIntegrate(
    taskId: string,
    message?: string,
  ): Promise<IntegrationResult> {
    const wt = this.worktrees.get(taskId);
    if (!wt) throw new Error(`git isolation: no worktree for ${taskId}`);
    const int = await this.ensureIntegration();
    const msg = message ?? `fleet(${taskId}): integrate`;

    const merge = await this.git(
      ["merge", "--no-ff", "-m", msg, wt.branch],
      int.path,
    );
    if (merge.code === 0) {
      const tip = await this.git(["rev-parse", "HEAD"], int.path);
      return { ok: true, commit: tip.stdout.trim(), taskBranch: wt.branch };
    }

    // Conflict. rerere may already have replayed a recorded resolution — if no
    // files remain unmerged, commit it and report success.
    const unmerged = await this.git(
      ["diff", "--name-only", "--diff-filter=U"],
      int.path,
    );
    const conflicts = unmerged.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (conflicts.length === 0) {
      const done = await this.git(
        ["commit", "--no-verify", "--no-edit"],
        int.path,
      );
      if (done.code === 0) {
        const tip = await this.git(["rev-parse", "HEAD"], int.path);
        return {
          ok: true,
          commit: tip.stdout.trim(),
          taskBranch: wt.branch,
          autoResolved: true,
        };
      }
    }

    // Real conflict: abort so the integration tree stays clean, and surface it.
    await this.git(["merge", "--abort"], int.path);
    const tip = await this.git(["rev-parse", wt.branch]);
    return {
      ok: false,
      conflicts,
      taskBranch: wt.branch,
      taskTip: tip.stdout.trim(),
    };
  }

  /** The integration branch + its worktree path, once at least one integrate ran. */
  integrationRef(): { path: string; branch: string } | null {
    return this.integration;
  }

  /**
   * Remove a task's worktree. Keeps the branch and the `refs/oxagen/agents` pins
   * (so nothing is lost). Pass `keep` to leave the worktree on disk — e.g. after
   * a conflict, so a resolver agent or human can work in it.
   */
  async dispose(taskId: string, opts: { keep?: boolean } = {}): Promise<void> {
    const wt = this.worktrees.get(taskId);
    if (!wt || opts.keep) return;
    await this.removeWorktree(wt.path);
    this.worktrees.delete(taskId);
  }

  /**
   * Tear down every worktree and prune. Keeps the integration branch (the
   * result) and all `refs/oxagen/agents` pins (the durability log).
   */
  async cleanupAll(): Promise<void> {
    for (const [id, wt] of this.worktrees) {
      await this.removeWorktree(wt.path);
      this.worktrees.delete(id);
    }
    if (this.integration) await this.removeWorktree(this.integration.path);
    await this.git(["worktree", "prune"]);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async ensureIntegration(): Promise<{ path: string; branch: string }> {
    if (this.integration) return this.integration;
    const branch = `fleet/${this.ns}/integration`;
    const path = join(this.root, this.ns, "integration");
    await this.removeWorktree(path);
    await this.git(["branch", "-D", branch]);
    const add = await this.git([
      "worktree",
      "add",
      "-b",
      branch,
      path,
      this.baseRef,
    ]);
    if (add.code !== 0) {
      throw new Error(
        `git isolation: integration worktree failed: ${add.stderr.trim()}`,
      );
    }
    this.integration = { path, branch };
    return this.integration;
  }

  private async removeWorktree(path: string): Promise<void> {
    if (!existsSync(path)) return;
    await this.git(["worktree", "remove", "--force", path]);
  }

  private async withIntegrateLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.integrateLock.then(fn, fn);
    this.integrateLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }

  /** Keep `.oxagen/` out of git's untracked list without touching tracked .gitignore. */
  private excludeWorktreeRoot(): void {
    try {
      const exclude = join(this.repoRoot, ".git", "info", "exclude");
      if (!existsSync(exclude)) return;
      const body = readFileSync(exclude, "utf8");
      if (!body.split("\n").some((l) => l.trim() === ".oxagen/")) {
        appendFileSync(exclude, `${body.endsWith("\n") ? "" : "\n"}.oxagen/\n`);
      }
    } catch {
      /* best-effort; isolation still works if we can't write the exclude */
    }
  }
}
