/**
 * Shell runners for the CLI.
 *
 * Two flavours share one hardening trick — spawning `bash -c <command>` in its
 * OWN process group (`detached: true`) so a kill/timeout can take down the whole
 * subtree via `process.kill(-pid, …)`, not just the top-level bash:
 *
 * - `runShellCommand` — STREAMING, backs the REPL's `!command` terminal escape.
 *   Emits stdout/stderr chunks live via `onData` so a long-running command
 *   (`pnpm build`, `pnpm test`) fills the red terminal panel line by line
 *   instead of appearing all at once after 100 seconds of silence.
 *
 * - `runShellCommandBuffered` — BUFFERED, backs the agent's `bash` tool and the
 *   engine `Workspace.exec` port. Collects stdout/stderr and resolves once with
 *   a {@link BufferedShellResult}.
 *
 * Why not just use Node's `child_process` `{ timeout }` option for the buffered
 * case? Because that option only signals the DIRECT child (the `bash -c` shell).
 * A command like `npm run lint | tail` does its real work in a grandchild
 * (`node`/eslint) that keeps the stdout pipe open; killing bash leaves the
 * grandchild alive, the stdio streams never hit EOF, and `exec`/`execFile` —
 * which resolve on stream *close*, not process exit — hang forever. Killing the
 * whole process group is the fix, so both runners here do exactly that.
 *
 * The user typed `!cmd` (or the agent's call was approved by the permission
 * broker) explicitly, so it runs directly in the workspace, exactly like a shell.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** How a finished shell run ended. */
export interface ShellRunResult {
  exitCode: number;
  /** True when the process was killed (by `kill()` or the timeout). */
  killed: boolean;
  /** True when the run hit its wall-clock timeout. */
  timedOut: boolean;
}

/** A live shell run: stream via the `onData` callback, control via this handle. */
export interface ShellRunHandle {
  /** Resolves when the process exits (or is killed). Never rejects. */
  done: Promise<ShellRunResult>;
  /** Terminate the process (SIGTERM, then SIGKILL after a grace period). */
  kill: () => void;
}

export interface RunShellOptions {
  command: string;
  cwd: string;
  /** Called with each stdout/stderr chunk as it streams in. */
  onData: (chunk: string) => void;
  /** Wall-clock cap; the process is killed if it runs longer. Default 10min. */
  timeoutMs?: number;
}

/**
 * Kill `child`'s whole process group with `signal`, falling back to a plain
 * `child.kill` if the group send fails (e.g. the process already exited or was
 * never detached). Negative pid targets the group (see `detached: true`).
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid != null) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already exited (ESRCH) or not permitted — nothing more to do.
  }
}

/**
 * Spawn `command` under `bash -c` in `cwd`, streaming combined stdout+stderr to
 * `onData`. Returns immediately with a handle — it never blocks the caller, so
 * the REPL stays fully interactive (and the agent can keep posting messages)
 * while the command runs.
 */
export function runShellCommand({
  command,
  cwd,
  onData,
  timeoutMs = 600_000,
}: RunShellOptions): ShellRunHandle {
  const child = spawn("bash", ["-c", command], {
    cwd,
    // Own process group so kill() can take down the whole tree (a shell that
    // spawned children), not just the top-level bash.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let killed = false;
  let timedOut = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => onData(c));
  child.stderr?.on("data", (c: string) => onData(c));

  const timer = setTimeout(() => {
    timedOut = true;
    killed = true;
    killProcessTree(child, "SIGTERM");
    // Escalate if the group ignores SIGTERM.
    setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000).unref();
  }, timeoutMs);

  const done = new Promise<ShellRunResult>((resolve) => {
    const finish = (exitCode: number): void => {
      clearTimeout(timer);
      resolve({ exitCode, killed, timedOut });
    };
    child.on("error", () => finish(127)); // e.g. bash not found
    child.on("close", (code, signal) => {
      // A signalled exit (SIGTERM from kill()/timeout) reports code === null.
      if (code == null) finish(signal ? 143 : 1);
      else finish(code);
    });
  });

  const kill = (): void => {
    if (killed) return;
    killed = true;
    killProcessTree(child, "SIGTERM");
    // Escalate if it ignores SIGTERM.
    setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000).unref();
  };

  return { done, kill };
}

/** Result of a {@link runShellCommandBuffered} run. Mirrors the engine `CommandResult`. */
export interface BufferedShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the run hit its wall-clock timeout and was killed. */
  timedOut: boolean;
}

export interface RunBufferedOptions {
  command: string;
  cwd: string;
  /** Wall-clock cap; the process group is killed if it runs longer. Default 2min. */
  timeoutMs?: number;
  /**
   * Per-stream cap in bytes; further output is dropped (not an error) so a
   * chatty build can't OOM the CLI. Default 10 MiB.
   */
  maxBuffer?: number;
  /**
   * Turn abort signal. When it fires (Esc / turn timeout / cancelled turn) the
   * whole process group is killed — otherwise a detached `bash -c` subtree would
   * keep running to its own `timeoutMs` (≤600s) after the turn was abandoned,
   * leaking work across a long bench run. Already-aborted ⇒ never spawns.
   */
  signal?: AbortSignal;
}

const TRUNCATION_NOTE = "\n… (output truncated)";

/**
 * Run `command` under `bash -c` in `cwd`, buffering stdout/stderr and resolving
 * once with a {@link BufferedShellResult}. NEVER rejects — a spawn error maps to
 * exit 127, a timeout to `timedOut: true` with exit 124.
 *
 * Unlike Node's `exec({ timeout })`, the timeout kills the whole process group
 * and hard-resolves even if a wedged grandchild keeps a pipe open, so the caller
 * (the agent's `bash` tool / `Workspace.exec`) can never hang indefinitely.
 */
export function runShellCommandBuffered({
  command,
  cwd,
  timeoutMs = 120_000,
  maxBuffer = 10 * 1024 * 1024,
  signal,
}: RunBufferedOptions): Promise<BufferedShellResult> {
  return new Promise<BufferedShellResult>((resolve) => {
    // Already-aborted turn: don't spawn at all.
    if (signal?.aborted) {
      resolve({
        exitCode: 124,
        stdout: "",
        stderr: "Aborted before start.",
        timedOut: false,
      });
      return;
    }
    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true, // own group so a timeout can kill the whole subtree
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      if (stdoutBytes >= maxBuffer) return;
      stdoutBytes += Buffer.byteLength(c);
      stdout += stdoutBytes > maxBuffer ? c + TRUNCATION_NOTE : c;
    });
    child.stderr?.on("data", (c: string) => {
      if (stderrBytes >= maxBuffer) return;
      stderrBytes += Buffer.byteLength(c);
      stderr += stderrBytes > maxBuffer ? c + TRUNCATION_NOTE : c;
    });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      // If SIGTERM is ignored (or 'close' never fires because a detached
      // grandchild is wedged on a pipe), escalate to SIGKILL and then
      // hard-resolve so the caller can never hang past the timeout.
      hardTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
        setTimeout(() => finish(124), 500).unref();
      }, 2_000);
      hardTimer.unref();
    }, timeoutMs);

    // Turn abort: kill the whole group (same SIGTERM→SIGKILL→hard-resolve dance
    // as the timeout) so an abandoned turn doesn't leak a running subtree.
    const onAbort = (): void => {
      if (settled) return;
      killProcessTree(child, "SIGTERM");
      hardTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
        setTimeout(() => finish(124), 500).unref();
      }, 2_000);
      hardTimer.unref();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", () => finish(127)); // e.g. bash not found
    child.on("close", (code, signal) => {
      if (code == null) finish(timedOut || signal ? 124 : 1);
      else finish(code);
    });
  });
}
