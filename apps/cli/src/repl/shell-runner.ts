/**
 * Streaming shell runner for the REPL's `!command` terminal escape.
 *
 * Unlike the engine `Workspace.exec` port (which buffers the whole process and
 * resolves only once it exits), this spawns `bash -c <command>` and emits stdout
 * and stderr chunks live via `onData` as they arrive — so a long-running command
 * (`pnpm build`, `pnpm test`) streams into the red terminal panel line by line
 * instead of appearing all at once after 100 seconds of silence.
 *
 * The user typed `!cmd` explicitly, so it runs directly in the workspace (not
 * through the agent's permission broker), exactly like a shell. The returned
 * handle exposes `kill()` (bound to Ctrl-C / Esc while a command is live) and a
 * `done` promise that settles with the exit code and whether it was killed.
 */
import { spawn } from "node:child_process";

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

  const killTree = (signal: NodeJS.Signals): void => {
    // Negative pid targets the whole process group (see `detached: true`).
    try {
      if (child.pid != null) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already exited — nothing to signal.
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killed = true;
    killTree("SIGTERM");
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
    killTree("SIGTERM");
    // Escalate if it ignores SIGTERM.
    setTimeout(() => killTree("SIGKILL"), 2_000).unref();
  };

  return { done, kill };
}
