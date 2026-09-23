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
 * The takeover moves the file aside under a name only this process uses and
 * reads it again, so two processes that both judged it stale cannot both
 * remove it, and a live lock created in between goes back. Releasing removes
 * the file only while it still names this acquisition, and any directory
 * that was made only to hold it, so an `unenroll` on a machine that was never
 * enrolled leaves nothing.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
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

interface Holder {
  pid?: number;
  at?: number;
  /** Unique to one acquisition, so a reused pid is not mistaken for it. */
  token?: string;
}

/** The lock file's text, or undefined when it is gone or cannot be read. */
function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function holderOf(text: string | undefined): Holder {
  try {
    return JSON.parse(text ?? "") as Holder;
  } catch {
    // A lock file cut short by a crash is nobody's.
    return {};
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
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
  const token = randomBytes(12).toString("hex");
  const liveHolder = (holder: Holder): number | undefined =>
    typeof holder.pid === "number" &&
    typeof holder.at === "number" &&
    now() - holder.at < STALE_AFTER_MS &&
    alive(holder.pid)
      ? holder.pid
      : undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now(), token }));
      closeSync(fd);
      return {
        release: () => {
          // A run that outlived the stale limit may have been taken over;
          // the lock on disk is then the other run's, and stays.
          if (holderOf(readLock(path)).token === token) removeQuietly(path);
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
      const live = liveHolder(holderOf(readLock(path)));
      if (live !== undefined) return { heldBy: live };
      // Stale. Move it aside rather than unlink it: of two processes that
      // both judged it stale, only one can move it, and the other's unlink
      // can no longer remove a lock the first has since created.
      const aside = `${path}.${process.pid}.${token}.stale`;
      try {
        renameSync(path, aside);
      } catch (renameError) {
        // Someone else took it over first; the next attempt reports them.
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      // What moved may be a live lock created after the read above. It goes
      // back, unless yet another has been created in its place.
      const moved = liveHolder(holderOf(readLock(aside)));
      if (moved !== undefined) {
        try {
          linkSync(aside, path);
        } catch {
          // Another lock is there now; the holder that lost its file is
          // the one reported.
        }
        removeQuietly(aside);
        return { heldBy: moved };
      }
      removeQuietly(aside);
    }
  }
  return { heldBy: -1 };
}
