/**
 * Live REPO panel data: worktree root, branch, and PR number. Combines
 * git-info.ts's synchronous, subprocess-free git read (cheap enough to
 * re-run on every refresh tick) with gh-pr.ts's async, network-bound PR
 * lookup (resolved in the background, cached, never blocking a frame).
 *
 * Refreshes on a timer (not just once at mount) because the branch can
 * change mid-session — e.g. a `!git checkout` run through the REPL's own
 * live-terminal feature — so the header/dock should catch up without a
 * restart.
 */
import { useEffect, useRef, useState } from "react";
import { resolveGitInfo } from "./git-info.js";
import { fetchPrNumber } from "./gh-pr.js";

export interface RepoInfo {
  /** Worktree/repo root directory; falls back to `cwd` outside a git repo. */
  root: string;
  /** Current branch; undefined outside a repo or on a detached HEAD. */
  branch: string | undefined;
  /** Open PR number for `branch`: a number once resolved, null = none/unavailable, undefined = not yet resolved. */
  prNumber: number | null | undefined;
}

/** How often to re-read git state and re-check for a PR. */
const REFRESH_MS = 30_000;

function readGitInfo(cwd: string): {
  root: string;
  branch: string | undefined;
} {
  const resolved = resolveGitInfo(cwd);
  return { root: resolved?.root ?? cwd, branch: resolved?.branch };
}

/**
 * `enabled` gates the whole hook (full-screen mode only — the classic inline
 * layout has no REPO panel to feed) so it never starts a timer or shells out
 * to `gh` in the common (inline/test) case.
 */
export function useRepoInfo(cwd: string, enabled: boolean): RepoInfo {
  const [info, setInfo] = useState<RepoInfo>(() => ({
    ...readGitInfo(cwd),
    prNumber: undefined,
  }));
  // Bumped on every PR fetch kicked off; a resolving fetch checks it's still
  // the LATEST one before applying its result, so a slow lookup for a branch
  // the user has since moved on from can never clobber a newer one (or apply
  // after unmount).
  const fetchGenRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refresh = (): void => {
      const { root, branch } = readGitInfo(cwd);
      setInfo((prev) =>
        prev.root === root && prev.branch === branch
          ? prev
          : { ...prev, root, branch },
      );

      const gen = ++fetchGenRef.current;
      if (!branch) {
        setInfo((prev) => ({ ...prev, prNumber: null }));
        return;
      }
      void fetchPrNumber(root, branch).then((pr) => {
        if (cancelled || gen !== fetchGenRef.current) return; // superseded or unmounted
        setInfo((prev) => ({ ...prev, prNumber: pr }));
      });
    };

    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cwd, enabled]);

  return info;
}
