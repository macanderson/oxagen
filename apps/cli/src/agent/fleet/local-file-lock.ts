/**
 * LocalFileLockProvider — the local-CLI implementation of the
 * `@oxagen/agent-engine` file-lock port (ADR-021 §5).
 *
 * Local fleets must not round-trip the platform on the write critical path
 * (ADR-019/021), so this backs the SAME port and fencing semantics as the
 * Postgres lease with two on-machine layers:
 *
 *   1. **In-process mutex** — a `Map` keyed by resource. The fleet runs every
 *      subagent task in ONE process, so this is the real guard: two tasks that
 *      both try to write the same file see each other as conflicting holders
 *      (the engine's `withFileLock` then retries briefly and, failing that,
 *      surfaces a "Blocked" tool result instead of clobbering).
 *   2. **Lock file** under `<root>/.oxagen/locks/` — an advisory JSON file per
 *      resource so a SECOND `oxagen` process on the same machine also sees the
 *      lock. Stale files (past their expiry) are taken over. This layer is
 *      read-then-write, NOT create-exclusive: two processes that check at the
 *      same instant can both grant. It is a courtesy signal between separate
 *      `oxagen` invocations, not a mutual-exclusion primitive — the in-process
 *      Map above is the guard the fleet actually relies on.
 *
 * Fencing tokens are monotonic per resource: a durable `<hash>.fence` counter
 * file (never deleted on release) is bumped on every successful acquire, so a
 * takeover after expiry always issues a strictly higher token than any prior
 * holder held. All methods fail SOFT — a filesystem hiccup degrades to the
 * in-process guard rather than crashing a turn.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { FileLockProvider, FileLockGrant } from "@oxagen/agent-engine";

/** Default lease window (5 min), matching the Postgres lease default. */
const DEFAULT_TTL_MS = 300_000;

interface LiveLock {
  lockId: string;
  holder: string;
  executionId: string;
  expiresAt: number;
  fencingToken: number;
}

interface LockFilePayload {
  lockId: string;
  holder: string;
  executionId: string;
  expiresAt: number;
  fencingToken: number;
  resourceKey: string;
}

const DENIED: FileLockGrant = {
  granted: false,
  lockId: "",
  heldBy: null,
  blockedUntil: null,
  fencingToken: null,
};

export interface LocalFileLockProviderOptions {
  /** Directory whose `.oxagen/locks/` holds the on-disk lock + fence files. */
  root: string;
  /** Lease length in ms (default 5 min). */
  ttlMs?: number;
  /** Injectable clock (tests drive TTL expiry deterministically); defaults to `Date.now`. */
  now?: () => number;
}

export function createLocalFileLockProvider(
  opts: LocalFileLockProviderOptions,
): FileLockProvider {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const locksDir = join(opts.root, ".oxagen", "locks");
  // In-process authority: resource key → the live lock (if any).
  const inProcess = new Map<string, LiveLock>();
  // In-process monotonic fence cache, seeded from disk on first touch.
  const fenceCache = new Map<string, number>();

  function keyOf(path: string): string {
    return normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
  }
  function hashOf(key: string): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 40);
  }
  function lockFilePath(key: string): string {
    return join(locksDir, `${hashOf(key)}.lock`);
  }
  function fenceFilePath(key: string): string {
    return join(locksDir, `${hashOf(key)}.fence`);
  }

  function readLockFile(key: string): LockFilePayload | null {
    try {
      const raw = readFileSync(lockFilePath(key), "utf8");
      return JSON.parse(raw) as LockFilePayload;
    } catch {
      return null;
    }
  }

  /** Next fencing token for a resource — max(in-process cache, on-disk fence, on-disk lock) + 1. */
  function nextFence(key: string): number {
    let current = fenceCache.get(key) ?? 0;
    try {
      const raw = readFileSync(fenceFilePath(key), "utf8");
      current = Math.max(current, Number.parseInt(raw, 10) || 0);
    } catch {
      // no fence file yet
    }
    const onDiskLock = readLockFile(key);
    if (onDiskLock) current = Math.max(current, onDiskLock.fencingToken);
    const next = current + 1;
    fenceCache.set(key, next);
    try {
      mkdirSync(locksDir, { recursive: true });
      writeFileSync(fenceFilePath(key), String(next), "utf8");
    } catch {
      // Best-effort durability — the in-process cache still guarantees
      // monotonicity for the common single-process fleet case.
    }
    return next;
  }

  function writeLockFile(key: string, payload: LockFilePayload): void {
    try {
      mkdirSync(locksDir, { recursive: true });
      writeFileSync(lockFilePath(key), JSON.stringify(payload), "utf8");
    } catch {
      // Cross-process visibility is best-effort; the in-process Map still guards.
    }
  }

  function removeLockFile(key: string): void {
    try {
      rmSync(lockFilePath(key), { force: true });
    } catch {
      // ignore
    }
  }

  return {
    async acquire({ path, agentId, executionId }): Promise<FileLockGrant> {
      try {
        const key = keyOf(path);
        const nowMs = now();

        // 1. In-process guard (the fleet's real concurrency model).
        const live = inProcess.get(key);
        if (live && live.expiresAt > nowMs && live.holder !== agentId) {
          return {
            granted: false,
            lockId: "",
            heldBy: live.holder,
            blockedUntil: live.expiresAt,
            fencingToken: null,
          };
        }

        // 2. Cross-process guard: a live lock file owned by a DIFFERENT holder blocks.
        if (!live) {
          const onDisk = readLockFile(key);
          if (onDisk && onDisk.expiresAt > nowMs && onDisk.holder !== agentId) {
            return {
              granted: false,
              lockId: "",
              heldBy: onDisk.holder,
              blockedUntil: onDisk.expiresAt,
              fencingToken: null,
            };
          }
        }

        // Grant / renew (same holder reuses its lockId).
        const token = nextFence(key);
        const lockId =
          live && live.holder === agentId ? live.lockId : randomUUID();
        const expiresAt = nowMs + ttlMs;
        inProcess.set(key, {
          lockId,
          holder: agentId,
          executionId,
          expiresAt,
          fencingToken: token,
        });
        writeLockFile(key, {
          lockId,
          holder: agentId,
          executionId,
          expiresAt,
          fencingToken: token,
          resourceKey: key,
        });
        return {
          granted: true,
          lockId,
          heldBy: null,
          blockedUntil: null,
          fencingToken: token,
        };
      } catch {
        // Never crash a tool call on a lock error — deny (the safe direction).
        return DENIED;
      }
    },

    release({ lockId, agentId }): void {
      for (const [key, live] of inProcess) {
        if (live.lockId === lockId && live.holder === agentId) {
          inProcess.delete(key);
          removeLockFile(key);
          return;
        }
      }
    },

    releaseAll(executionId: string): void {
      for (const [key, live] of [...inProcess]) {
        if (live.executionId === executionId) {
          inProcess.delete(key);
          removeLockFile(key);
        }
      }
    },
  };
}
