/**
 * One installer at a time. `enroll`, `unenroll` and `reassign` each mint or
 * revoke an enrollment, rewrite host.json, reload the service and edit four
 * files the user owns; two of them interleaved (a double click in the desktop
 * app, the app and a terminal at once) leave an enrollment on the control
 * plane that no host.json names and hooks carrying an id the daemon does not
 * know.
 *
 * The lock is a pid file created with `O_EXCL`. A holder that died is taken
 * over: its pid no longer exists, or the file is older than any run could be.
 * Releasing removes the file and any directory that was made only to hold it,
 * so an `unenroll` on a machine that was never enrolled leaves nothing.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Longer than any run: the slowest step is a 10 s exec and a 5 s health wait. */
const STALE_AFTER_MS = 10 * 60_000;

export interface InstallLock {
  release: () => void;
}

export interface LockHeld {
  heldBy: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireInstallLock(
  root: string,
  now: () => number = Date.now,
  alive: (pid: number) => boolean = pidAlive,
): InstallLock | LockHeld {
  const path = join(root, "install.lock");
  const created: string[] = [];
  let dir = root;
  while (!existsSync(dir) && dirname(dir) !== dir) {
    created.unshift(dir);
    dir = dirname(dir);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
      closeSync(fd);
      return {
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            // Already released.
          }
          for (const made of [...created].reverse()) {
            try {
              if (readdirSync(made).length === 0) rmdirSync(made);
            } catch {
              // In use by now, or gone.
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: { pid?: number; at?: number } = {};
      try {
        holder = JSON.parse(readFileSync(path, "utf8")) as typeof holder;
      } catch {
        // A lock file cut short by a crash is nobody's.
      }
      const live =
        typeof holder.pid === "number" &&
        typeof holder.at === "number" &&
        now() - holder.at < STALE_AFTER_MS &&
        alive(holder.pid);
      if (live) return { heldBy: holder.pid as number };
      try {
        unlinkSync(path);
      } catch {
        // Someone else took it over first; the next attempt reports them.
      }
    }
  }
  return { heldBy: -1 };
}
