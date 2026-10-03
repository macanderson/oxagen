/**
 * The lock Claude Code takes to save its user config (#5287).
 *
 * Claude Code rewrites `~/.claude.json` often: at each session start, for
 * each project it opens, and for each setting a person changes. It saves
 * under `proper-lockfile`, whose lock is a directory named `<file>.lock`
 * made with `mkdir`, and it reads the file again inside that lock before it
 * writes. Claude Code 2.1.288 passes the lock path as the config path plus
 * `.lock`, without resolving a symlink, and keeps proper-lockfile's defaults:
 * a lock untouched for 10 seconds is stale.
 *
 * An edit made without that lock can be lost. A save that read the file just
 * before the edit writes the old content back just after it. On a machine
 * with many Claude Code sessions open, saves are constant, so Oxagen takes
 * the same lock around its own read, merge, and write.
 */
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { HarnessFileError } from "./harness-file";

/** proper-lockfile's default: a lock untouched this long is stale. */
export const CLAUDE_CONFIG_LOCK_STALE_MS = 10_000;

/** How long Oxagen waits for Claude Code to finish a save. */
export const CLAUDE_CONFIG_LOCK_WAIT_MS = 3_000;

const RETRY_MS = 25;

export interface ClaudeConfigLockOptions {
  staleMs?: number;
  waitMs?: number;
  /** Injected in tests. */
  now?: () => number;
  sleep?: (ms: number) => void;
}

/** Block this thread for `ms`. The writers that call this are synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The lock directory Claude Code makes for `file`. */
export function claudeConfigLockPath(file: string): string {
  return `${file}.lock`;
}

/**
 * Run `edit` while holding the lock Claude Code saves `file` under, and
 * release the lock afterwards, whether `edit` returns or throws.
 *
 * A lock older than the stale limit is removed and taken, as proper-lockfile
 * does. A live lock is waited on. If it is still held after the wait, this
 * throws a `HarnessFileError` that names the file, and nothing is written.
 * When the directory that would hold `file` does not exist, no Claude Code
 * can be saving it, so `edit` runs without a lock.
 */
export function withClaudeConfigLock<T>(
  file: string,
  edit: () => T,
  options: ClaudeConfigLockOptions = {},
): T {
  const lock = claudeConfigLockPath(file);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const staleMs = options.staleMs ?? CLAUDE_CONFIG_LOCK_STALE_MS;
  const waitMs = options.waitMs ?? CLAUDE_CONFIG_LOCK_WAIT_MS;
  const deadline = now() + waitMs;
  let held = false;
  for (;;) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The config's directory is missing, so the config is too.
      if (code === "ENOENT") break;
      if (code !== "EEXIST") throw error;
    }
    let modified: number | undefined;
    try {
      modified = statSync(lock).mtimeMs;
    } catch {
      // Released between the mkdir and the stat: try again at once.
      modified = undefined;
    }
    // A released lock, or a stale one this run removed, is tried again at
    // once. Anything else waits a moment first.
    let retryNow = modified === undefined;
    if (modified !== undefined && now() - modified > staleMs) {
      try {
        // Only the lock judged stale: one that a live process made in the
        // meantime has a new mtime and stays.
        if (statSync(lock).mtimeMs === modified) {
          rmdirSync(lock);
          retryNow = true;
        }
      } catch {
        // Another process removed or took it first.
      }
    }
    if (now() >= deadline)
      throw new HarnessFileError(
        file,
        `is being saved by Claude Code, which held its lock (${lock}) for more than ${Math.round(waitMs / 1000)} seconds; nothing was written, so run the command again in a moment`,
      );
    if (!retryNow) sleep(RETRY_MS);
  }
  try {
    return edit();
  } finally {
    if (held) {
      try {
        rmdirSync(lock);
      } catch {
        // Already gone: a process that judged it stale removed it.
      }
    }
  }
}
