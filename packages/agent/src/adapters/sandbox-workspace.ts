// ModalSandboxWorkspace — a real, execution-capable Workspace for the platform
// coding agent, backed by a durable Modal sandbox session.
//
// ADR-019 layering: the engine's `Workspace` port is dependency-light and lives
// in @oxagen/agent-engine. This adapter binds that port to the platform's
// durable-session plumbing (the `agent.sandbox.*` handlers + the sandbox_sessions
// registry), so it lives with the platform (packages/agent), NOT in the engine.
//
// Every filesystem op and command runs THROUGH the existing
// `agentSandboxExecHandler`, so we inherit for free: reuse-by-sessionKey, snapshot
// restore-on-reap, tenant scoping, and exec metering. File reads/writes are
// implemented as base64-framed shell commands over the same `execInSession`
// primitive `agent.sandbox.files.list` already uses — no per-driver FS surface.
import {
  isSandboxAvailable,
  WORKSPACE_ROOT,
  isSafeWorkspacePath,
} from "@oxagen/sandbox";
import type { Workspace, CommandResult } from "@oxagen/agent-engine";
import { runInTenantScope } from "@oxagen/tenancy";
import type { CapabilityContext } from "../types";
import { agentSandboxStartHandler } from "../handlers/agent.sandbox.start";
import { agentSandboxExecHandler } from "../handlers/agent.sandbox.exec";
import { agentSandboxStopHandler } from "../handlers/agent.sandbox.stop";
import { releaseSession } from "../handlers/_sandbox-session";
import { captureSandboxCommandLogs } from "../handlers/_sandbox-logs";

/** Thrown when a sandbox-backed workspace is used with no driver configured. */
export class SandboxWorkspaceUnavailableError extends Error {
  readonly code = "sandbox_workspace_unavailable";
  constructor() {
    super(
      "Sandbox-backed workspace is unavailable. Set SANDBOX_ENABLED=true and a " +
        "session-capable driver (Modal: SANDBOX_DRIVER=modal + MODAL_RUNNER_URL + " +
        "MODAL_RUNNER_TOKEN).",
    );
    this.name = "SandboxWorkspaceUnavailableError";
  }
}

export interface SandboxRepoSpec {
  owner: string;
  repo: string;
  /** Branch/ref to clone. Defaults to the repo's default branch. */
  ref?: string;
  /** GitHub token for private clones. Injected via git credential store, never logged. */
  token?: string;
}

export interface ModalSandboxWorkspaceOptions {
  ctx: CapabilityContext;
  /**
   * Stable reuse key so all turns of one conversation share ONE warm sandbox.
   * Derive deterministically from (workspaceId, conversationId/repoId).
   */
  sessionKey: string;
  /** Optional workspace environment whose vault secrets are injected per exec. */
  environmentId?: string;
  /** Optional repo cloned once (idempotently) into the session workspace. */
  repo?: SandboxRepoSpec;
  /** Default per-command timeout (ms) for the bash tool. */
  defaultTimeoutMs?: number;
}

// A comfortable ceiling for internal FS commands (read/write/list/glob/grep).
const FS_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const GREP_MAX_HITS = 200;

/** Single-quote a value for POSIX `sh -c`. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Normalize a caller path to a workspace-relative, root-confined form. */
function toRelPath(p: string): string {
  const rel = p.replace(/^\/+/, "").replace(/^\.\//, "");
  if (rel !== "" && !isSafeWorkspacePath(rel)) {
    throw new Error(`unsafe workspace path: ${JSON.stringify(p)}`);
  }
  return rel;
}

export class ModalSandboxWorkspace implements Workspace {
  readonly root = WORKSPACE_ROOT;

  private readonly ctx: CapabilityContext;
  private readonly sessionKey: string;
  private readonly environmentId?: string;
  private readonly repo?: SandboxRepoSpec;
  private readonly defaultTimeoutMs: number;

  /** Memoized session bootstrap (start + clone). Runs at most once per instance. */
  private sessionPromise: Promise<string> | null = null;
  private sessionId: string | null = null;

  constructor(opts: ModalSandboxWorkspaceOptions) {
    this.ctx = opts.ctx;
    this.sessionKey = opts.sessionKey;
    this.environmentId = opts.environmentId;
    this.repo = opts.repo;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  /**
   * Lazily start (or reconnect to) the durable session and clone the repo once.
   * Memoized: concurrent callers await the same bootstrap. Throws a TYPED error
   * (never a stub success) when no sandbox driver is configured.
   */
  private async ensureSession(): Promise<string> {
    if (this.sessionPromise) return this.sessionPromise;
    if (!isSandboxAvailable()) throw new SandboxWorkspaceUnavailableError();
    // Clear the memo on failure. Caching a REJECTED promise would poison the
    // instance: every later op would replay one transient start/clone error for
    // the life of the turn instead of retrying.
    this.sessionPromise = this.bootstrap().catch((err: unknown) => {
      this.sessionPromise = null;
      throw err;
    });
    return this.sessionPromise;
  }

  /**
   * Run a durable-session handler inside this workspace's tenant scope. The
   * handlers use withTenantDb (ALS-scoped), and this workspace is driven from
   * the engine's tool loop, which does NOT guarantee an active scope — so we
   * establish one here. Re-entrant: nesting inside the kernel's own scope (the
   * agent.repo.edit path) simply re-sets the same tenant and is harmless.
   */
  private withScope<T>(fn: () => Promise<T>): Promise<T> {
    return runInTenantScope(
      { orgId: this.ctx.orgId, workspaceId: this.ctx.workspaceId },
      fn,
    );
  }

  private async bootstrap(): Promise<string> {
    const start = await this.withScope(() =>
      agentSandboxStartHandler(
        {
          image: "agent",
          sessionKey: this.sessionKey,
          memoryMb: 2048,
          ttlSeconds: 86_400,
          idleTimeoutSeconds: 1_200,
          network: "allow",
          environmentId: this.environmentId,
        },
        this.ctx,
      ),
    );
    this.sessionId = start.sessionId;
    if (this.repo) await this.ensureCloned(start.sessionId, this.repo);
    return start.sessionId;
  }

  /**
   * Clone the repo into the workspace root exactly once. Idempotent via a
   * `.git` marker so a reused/restored session is not re-cloned. The token is
   * staged into git's credential store through env (never in the command line
   * or stdout), so it cannot leak via clone error output.
   */
  private async ensureCloned(
    sessionId: string,
    repo: SandboxRepoSpec,
  ): Promise<void> {
    const url = `https://github.com/${repo.owner}/${repo.repo}.git`;
    const branchFlag = repo.ref ? `--branch ${shq(repo.ref)} ` : "";

    if (repo.token) {
      await this.execRaw(sessionId, {
        command:
          "git config --global credential.helper store && umask 077 && " +
          'printf "https://x-access-token:%s@github.com\\n" "$OXA_GH_TOKEN" > "$HOME/.git-credentials"',
        timeoutMs: FS_TIMEOUT_MS,
        env: { OXA_GH_TOKEN: repo.token },
      });
    }

    const root = shq(this.root);
    const clone =
      `if [ ! -e ${root}/.git ]; then rm -rf ${root} && ` +
      `git clone --depth 1 ${branchFlag}${shq(url)} ${root}; fi`;
    const res = await this.execRaw(sessionId, {
      command: clone,
      timeoutMs: 600_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `git clone failed for ${repo.owner}/${repo.repo} (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`,
      );
    }
  }

  /** Terminate the durable session. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    try {
      await this.withScope(() =>
        agentSandboxStopHandler({ sessionId }, this.ctx),
      );
    } catch {
      // Best-effort teardown; the registry TTL reaps an orphaned session anyway.
    }
  }

  /**
   * Release the session at turn end WITHOUT tearing the sandbox down: mark it
   * 'idle' and start its reap grace clock, so the next turn of the same
   * conversation reconnects to this same warm sandbox (and its working tree,
   * including uncommitted edits). The sandbox-reaper drops it ~2-3 min later if
   * no turn resumes — recovering any dirty work to a branch first
   * (spec: sandbox-session-lifecycle §4). Use this, NOT dispose(), for a
   * persistent per-conversation coding session. Safe to call multiple times.
   */
  async release(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    try {
      await this.withScope(() => releaseSession(this.ctx, sessionId));
    } catch {
      // Best-effort; a failed release just leaves the session 'running' until the
      // reaper's stale-running backstop reclaims it. Work is never at risk.
    }
  }

  // ── Command execution ──────────────────────────────────────────────────────

  /** Run a command in the session, restoring-on-reap via the shared handler. */
  private async execRaw(
    sessionId: string,
    opts: {
      command: string;
      timeoutMs: number;
      env?: Record<string, string>;
      stdin?: string;
    },
  ): Promise<CommandResult> {
    const out = await this.withScope(() =>
      agentSandboxExecHandler(
        {
          sessionId,
          command: opts.command,
          timeoutMs: opts.timeoutMs,
          env: opts.env,
          stdin: opts.stdin,
        },
        this.ctx,
      ),
    );
    return {
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      timedOut: out.timedOut,
    };
  }

  /**
   * Public Workspace.exec — runs the caller's command in the repo root.
   *
   * LIMITATION: `opts.signal` is accepted for port compatibility but is NOT
   * honored — the durable-session exec handler has no cancellation seam, so an
   * abort mid-command only abandons the caller's await; the command keeps
   * running in the sandbox until its `timeoutMs` elapses.
   */
  async exec(
    command: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CommandResult> {
    const sessionId = await this.ensureSession();
    // Run in the workspace root so relative paths resolve against the clone.
    const wrapped = `cd ${shq(this.root)} && ${command}`;
    const startedAt = Date.now();
    const result = await this.execRaw(sessionId, {
      command: wrapped,
      timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs,
    });
    // Capture the agent's REAL command output for the sandbox inspector's log
    // console (fire-and-forget; the ORIGINAL command, not the `cd` wrapper).
    // Only exec() is captured — internal FS ops via execRaw are excluded so the
    // console shows agent commands, not readFile/list/grep plumbing.
    void captureSandboxCommandLogs(
      this.ctx,
      sessionId,
      command,
      result,
      Date.now() - startedAt,
    );
    return result;
  }

  // ── Filesystem: reads ──────────────────────────────────────────────────────

  async readFile(
    p: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<string> {
    const sessionId = await this.ensureSession();
    const abs = `${this.root}/${toRelPath(p)}`;
    // base64 so exact bytes/newlines survive the shell round-trip; Node's decoder
    // ignores the wrap newlines coreutils inserts.
    const res = await this.execRaw(sessionId, {
      command: `base64 ${shq(abs)}`,
      timeoutMs: FS_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) throw new Error(`ENOENT: ${p}`);
    const text = Buffer.from(res.stdout, "base64").toString("utf8");
    if (opts?.offset == null && opts?.limit == null) return text;
    const lines = text.split("\n");
    // `offset` is a 1-based line number. Clamp at 0 so offset 0 (or a negative)
    // reads from the top — an unclamped negative index would make slice() count
    // back from the END of the file and silently return the wrong lines.
    const startLine = Math.max(0, opts?.offset != null ? opts.offset - 1 : 0);
    const end = opts?.limit != null ? startLine + opts.limit : lines.length;
    return lines.slice(startLine, end).join("\n");
  }

  async list(dir?: string): Promise<string[]> {
    const sessionId = await this.ensureSession();
    const rel = dir ? toRelPath(dir) : "";
    const abs = rel ? `${this.root}/${rel}` : this.root;
    const res = await this.execRaw(sessionId, {
      command: `ls -1A ${shq(abs)} 2>/dev/null`,
      timeoutMs: FS_TIMEOUT_MS,
    });
    return res.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .sort();
  }

  async glob(pattern: string): Promise<string[]> {
    const sessionId = await this.ensureSession();
    // Enumerate tracked+untracked files, then filter with the same glob→regex
    // the GitHub workspace uses, so glob semantics match across backends.
    // fd (parallel traversal) when the image ships it; --hidden --no-ignore
    // keeps its result set byte-identical to the find fallback. The fallback
    // must be `command find`: the Modal runner's exec trampoline aliases
    // find→fd for agent-typed commands, and fd cannot parse find's flags.
    const enumerate =
      "if command -v fd >/dev/null 2>&1; " +
      "then fd --type f --hidden --no-ignore --exclude .git 2>/dev/null; " +
      "else command find . -type f -not -path '*/.git/*' 2>/dev/null | sed 's|^\\./||'; fi";
    const res = await this.execRaw(sessionId, {
      command: `cd ${shq(this.root)} && ${enumerate}`,
      timeoutMs: FS_TIMEOUT_MS,
    });
    const re = globToRegExp(pattern);
    return res.stdout
      .split("\n")
      .filter((f) => f.length > 0 && re.test(f))
      .sort();
  }

  async grep(
    pattern: string,
    opts?: { path?: string; glob?: string },
  ): Promise<string[]> {
    const sessionId = await this.ensureSession();
    const searchPath = opts?.path ? shq(toRelPath(opts.path) || ".") : "'.'";
    // Real recursive search in the sandbox: ripgrep when the image ships it
    // (parallel + SIMD, same file:line:text output), POSIX grep otherwise.
    // The fallback must be `command grep` — the Modal runner's exec trampoline
    // aliases grep→rg for agent-typed commands, and rg cannot parse grep's
    // -rInE bundle. --hidden --no-ignore keeps rg's result set identical to
    // grep -rI (both skip binaries). Hits are capped to keep tool output
    // bounded (ADR-021 §3); the sed strips the ./ prefix so both branches emit
    // identical paths and the .git post-filter actually applies.
    const rgGlob = opts?.glob ? ` -g ${shq(opts.glob)}` : "";
    const grepInclude = opts?.glob ? ` --include=${shq(opts.glob)}` : "";
    const search =
      "if command -v rg >/dev/null 2>&1; " +
      `then rg --line-number --no-heading --hidden --no-ignore${rgGlob} -- ${shq(pattern)} ${searchPath}; ` +
      `else command grep -rInE${grepInclude} -- ${shq(pattern)} ${searchPath}; fi`;
    const cmd =
      `cd ${shq(this.root)} && { ${search}; } 2>/dev/null ` +
      `| sed 's|^\\./||' | command grep -v '^\\.git/' | head -n ${GREP_MAX_HITS}`;
    const res = await this.execRaw(sessionId, {
      command: cmd,
      timeoutMs: FS_TIMEOUT_MS,
    });
    return res.stdout.split("\n").filter((l) => l.length > 0);
  }

  // ── Filesystem: writes ─────────────────────────────────────────────────────

  async writeFile(p: string, content: string): Promise<void> {
    const sessionId = await this.ensureSession();
    const abs = `${this.root}/${toRelPath(p)}`;
    // Content travels as base64 over stdin so it never sits in the command line
    // (no length cap, no quoting hazard, exact bytes preserved).
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    const res = await this.execRaw(sessionId, {
      command: `mkdir -p ${shq(dir)} && base64 -d > ${shq(abs)}`,
      timeoutMs: FS_TIMEOUT_MS,
      stdin: Buffer.from(content, "utf8").toString("base64"),
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `write failed for ${p} (exit ${res.exitCode}): ${res.stderr.slice(0, 300)}`,
      );
    }
  }

  async editFile(
    p: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean },
  ): Promise<number> {
    // Read-modify-write in the adapter so the edit semantics and corrective
    // error messages exactly match the other Workspace backends.
    const text = await this.readFile(p);
    const count = oldString === "" ? 0 : text.split(oldString).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${p}`);
    if (opts?.replaceAll) {
      await this.writeFile(p, text.split(oldString).join(newString));
      return count;
    }
    if (count > 1) {
      throw new Error(
        `old_string appears ${count} times in ${p}; must be unique`,
      );
    }
    await this.writeFile(p, text.replace(oldString, newString));
    return 1;
  }

  // ── Diff / changed files ───────────────────────────────────────────────────

  /**
   * The full working-tree diff. NOT read-only: it runs `git add -A` first so
   * untracked files show up, which leaves everything staged in the session's
   * index.
   */
  async diff(): Promise<string> {
    const sessionId = await this.ensureSession();
    const res = await this.execRaw(sessionId, {
      command: `cd ${shq(this.root)} && git add -A >/dev/null 2>&1; git --no-pager diff --cached`,
      timeoutMs: FS_TIMEOUT_MS,
    });
    return res.stdout;
  }

  /**
   * Enumerate every path changed since the clone and read back its content, for
   * the GitHub commit path (agent.repo.edit stages these via the Contents API).
   * `git add -A` first so untracked files are included; diff against HEAD covers
   * committed and uncommitted work alike in a shallow clone.
   */
  async getChangedFiles(): Promise<{ path: string; content: string }[]> {
    const sessionId = await this.ensureSession();
    const res = await this.execRaw(sessionId, {
      command:
        `cd ${shq(this.root)} && git add -A >/dev/null 2>&1; ` +
        `git --no-pager diff --cached --name-only --diff-filter=d`,
      timeoutMs: FS_TIMEOUT_MS,
    });
    const paths = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const out: { path: string; content: string }[] = [];
    for (const path of paths) {
      out.push({ path, content: await this.readFile(path) });
    }
    return out;
  }

  /** The durable session's public id, once started (for telemetry/reuse). */
  get currentSessionId(): string | null {
    return this.sessionId;
  }
}

// ---------------------------------------------------------------------------
// Inline glob helper — identical algorithm to GitHubWorkspace and the engine's
// internal glob (neither is importable here), so glob() matches across backends.
// ---------------------------------------------------------------------------
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c as string)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
