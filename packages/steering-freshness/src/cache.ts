/**
 * cache.ts — the throttle that keeps a network fetch off the front of every
 * prompt.
 *
 * The check runs on every prompt submission. Fetching every time would put a
 * remote round trip between pressing enter and the model starting, which is
 * the surest way to get the gate uninstalled. So the fetch is throttled to
 * `fetchIntervalSeconds` and the timestamp lives in a file.
 *
 * Where that file lives matters more than it looks. It cannot go under
 * `.oxagen/` — that is the directory whose cleanliness decides whether a sync
 * is safe, and a cache write there would make every checkout permanently
 * dirty, permanently unsyncable, and would show up in `git status` forever.
 * It goes in git's own common directory, which is per-repository, shared
 * across worktrees (the throttle is about the remote, which every worktree
 * shares), already ignored by every tool, and removed when the clone is.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FetchStamp {
  /** Epoch milliseconds of the last attempt, successful or not. */
  attemptedAt: number;
  /** The remote/branch the attempt was for; a change invalidates the stamp. */
  target: string;
  ok: boolean;
}

export interface CacheIo {
  read: typeof readFile;
  write: typeof writeFile;
  mkdirp: (path: string) => Promise<unknown>;
}

const defaultIo: CacheIo = {
  read: readFile,
  write: writeFile,
  mkdirp: (path) => mkdir(path, { recursive: true }),
};

/**
 * The stamp's path inside the repository's git common directory.
 *
 * `gitCommonDir` is what `git rev-parse --git-common-dir` returns, which is
 * the *main* repository's `.git` even from inside a linked worktree — so all
 * of a developer's worktrees share one throttle instead of each paying its
 * own fetch.
 */
export function stampPath(gitCommonDir: string): string {
  return join(gitCommonDir, "oxagen", "steering-freshness.json");
}

export async function readFetchStamp(
  gitCommonDir: string,
  io: CacheIo = defaultIo,
): Promise<FetchStamp | null> {
  try {
    const raw = await io.read(stampPath(gitCommonDir), "utf8");
    const parsed = JSON.parse(String(raw)) as Partial<FetchStamp>;
    if (
      typeof parsed.attemptedAt !== "number" ||
      typeof parsed.target !== "string"
    ) {
      return null;
    }
    return {
      attemptedAt: parsed.attemptedAt,
      target: parsed.target,
      ok: parsed.ok === true,
    };
  } catch {
    // A missing, unreadable or corrupt stamp means "no idea when we last
    // fetched", which correctly resolves to "fetch now".
    return null;
  }
}

export async function writeFetchStamp(
  gitCommonDir: string,
  stamp: FetchStamp,
  io: CacheIo = defaultIo,
): Promise<void> {
  const path = stampPath(gitCommonDir);
  try {
    await io.mkdirp(dirname(path));
    await io.write(path, `${JSON.stringify(stamp)}\n`, "utf8");
  } catch {
    // A cache that cannot be written costs a fetch per prompt. It is not a
    // reason to fail a check, and the throttle is the only thing lost.
  }
}

/**
 * Should we go to the network now?
 *
 * `intervalSeconds` of 0 means every time — the setting an organisation
 * picks when correctness beats latency. A stamp for a different
 * remote/branch never suppresses a fetch: it is an answer to a different
 * question.
 */
export function shouldFetch(
  stamp: FetchStamp | null,
  target: string,
  intervalSeconds: number,
  now: number,
): boolean {
  if (intervalSeconds <= 0) return true;
  if (!stamp || stamp.target !== target) return true;
  // A clock that moved backwards (a laptop waking, a corrected NTP skew)
  // must not lock the throttle shut until real time catches up.
  if (stamp.attemptedAt > now) return true;
  return now - stamp.attemptedAt >= intervalSeconds * 1000;
}

/**
 * Whether ANY call to this remote is due, ignoring which branch was last
 * fetched.
 *
 * `shouldFetch` answers "should I fetch THIS target", and a stamp for another
 * branch never suppresses it, because that is an answer to a different
 * question. Resolving the default branch asks a different question again —
 * "may I contact the remote at all right now" — and it has to be answered
 * BEFORE the target is known, since the target is what the answer produces.
 *
 * The same interval governs both, so a checkout that fetched a moment ago does
 * not also re-ask the server which branch is default before every prompt.
 */
export function shouldContactRemote(
  stamp: FetchStamp | null,
  intervalSeconds: number,
  now: number,
): boolean {
  if (intervalSeconds <= 0) return true;
  if (!stamp) return true;
  // A clock that moved backwards must not lock the throttle shut.
  if (stamp.attemptedAt > now) return true;
  return now - stamp.attemptedAt >= intervalSeconds * 1000;
}
