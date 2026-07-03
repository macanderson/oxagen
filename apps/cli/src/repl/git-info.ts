/**
 * Best-effort, subprocess-free git info: the repo/worktree root and current
 * branch, resolved by walking up from `cwd` and reading `.git`/HEAD directly
 * — no `git` subprocess, so it's cheap enough to call on every render or on
 * a periodic refresh (see use-repo-info.ts) without ever blocking.
 *
 * Correctly handles git WORKTREES, where `.git` in the worktree directory is
 * a plain-text FILE (not a directory) containing `gitdir: <path-to-the-real-
 * gitdir>` — e.g. `.git/worktrees/<name>` under the main checkout. Every
 * worktree has its OWN HEAD inside that pointed-to gitdir, distinct from the
 * main checkout's. A naive `join(cwd, ".git", "HEAD")` (this repo's previous
 * implementation) silently fails here: `.git` is a file, so nothing can
 * exist "inside" it, and walking further up never finds the main repo's
 * `.git` either (a worktree lives in its own directory tree, not nested
 * under the main checkout) — the branch chip just went blank. Given this
 * codebase's own heavy worktree-per-task workflow (see CLAUDE.md), that
 * silent gap was worth fixing outright, not just working around.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export interface GitInfo {
  /** Directory containing the `.git` entry — the repo (or worktree) root. */
  root: string;
  /** Current branch name; undefined outside a repo or on a detached HEAD. */
  branch: string | undefined;
}

/** How many ancestor directories to walk before giving up. */
const MAX_WALK_UP = 64;

/**
 * Resolves the real gitdir for a found `.git` entry: itself, if it's already
 * a directory (the common case); or the path a worktree's `gitdir:` pointer
 * file names (resolved relative to the entry's own directory, since git
 * writes worktree gitdir pointers as relative paths on most platforms).
 */
function resolveGitDir(gitEntry: string): string {
  const stat = statSync(gitEntry);
  if (stat.isDirectory()) return gitEntry;
  const content = readFileSync(gitEntry, "utf8").trim();
  const m = content.match(/^gitdir:\s*(.+)$/);
  if (!m) return gitEntry; // malformed pointer — caller's existsSync(HEAD) just won't find it
  const pointed = m[1]!.trim();
  return isAbsolute(pointed) ? pointed : join(dirname(gitEntry), pointed);
}

/** Reads `<gitDir>/HEAD` and extracts the branch name; undefined on a detached HEAD. */
function readBranchFromGitDir(gitDir: string): string | undefined {
  const head = join(gitDir, "HEAD");
  if (!existsSync(head)) return undefined;
  const ref = readFileSync(head, "utf8").trim();
  const m = ref.match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1] : undefined;
}

/**
 * Walks up from `cwd` to the nearest `.git` entry (file or directory —
 * worktree or main checkout) and resolves the repo/worktree root + current
 * branch. Returns undefined outside a repo entirely, or on any read failure
 * (never throws — this is best-effort UI chrome, not a git command).
 */
export function resolveGitInfo(cwd: string): GitInfo | undefined {
  try {
    let dir = cwd;
    for (let i = 0; i < MAX_WALK_UP; i++) {
      const gitEntry = join(dir, ".git");
      if (existsSync(gitEntry)) {
        const gitDir = resolveGitDir(gitEntry);
        return { root: dir, branch: readBranchFromGitDir(gitDir) };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not a repo / unreadable — no repo info */
  }
  return undefined;
}

/**
 * Keeps a path's most useful (trailing) segment when it's too long to show
 * in full — a leading "…" plus the tail, rather than truncating the end and
 * losing the actually-identifying part (the deepest directory name).
 */
export function truncatePathStart(path: string, maxLen: number): string {
  if (path.length <= maxLen || maxLen <= 1) return path;
  return "…" + path.slice(path.length - (maxLen - 1));
}
