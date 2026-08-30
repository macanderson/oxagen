/**
 * Unit tests for git-info.ts's subprocess-free git resolution — built against
 * REAL temp-directory fixtures (mkdtemp + real .git/HEAD files) rather than
 * mocked fs, since the whole point is proving the filesystem-shape handling
 * is right, including the worktree case that this module fixes: a worktree's
 * `.git` is a plain-text FILE (`gitdir: <path>`), not a directory, and the
 * REPL's previous implementation silently returned no branch for it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  resolveGitInfo,
  truncatePathStart,
  abbreviateHome,
  abbreviatePath,
} from "../git-info.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "oxagen-git-info-test-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveGitInfo — normal (non-worktree) repo", () => {
  it("reads the branch from a regular .git/HEAD directory", () => {
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, ".git", "HEAD"), "ref: refs/heads/main\n");
    const info = resolveGitInfo(base);
    expect(info?.root).toBe(base);
    expect(info?.branch).toBe("main");
  });

  it("handles a branch name containing slashes (feat/x/y)", () => {
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, ".git", "HEAD"), "ref: refs/heads/feat/x/y\n");
    expect(resolveGitInfo(base)?.branch).toBe("feat/x/y");
  });

  it("returns undefined branch on a detached HEAD (a raw SHA, no ref: prefix)", () => {
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, ".git", "HEAD"), "abc123def456\n");
    const info = resolveGitInfo(base);
    expect(info?.root).toBe(base);
    expect(info?.branch).toBeUndefined();
  });

  it("walks up from a nested subdirectory to find the repo root", () => {
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, ".git", "HEAD"), "ref: refs/heads/main\n");
    const nested = join(base, "apps", "cli", "src");
    mkdirSync(nested, { recursive: true });
    const info = resolveGitInfo(nested);
    expect(info?.root).toBe(base);
    expect(info?.branch).toBe("main");
  });
});

describe("resolveGitInfo — git WORKTREE (the bug this module fixes)", () => {
  it("follows the .git pointer FILE to the real gitdir and reads ITS HEAD", () => {
    // Mirrors real git worktree layout: <worktree>/.git is a plain-text file
    // naming the real gitdir, which lives elsewhere (typically under the main
    // checkout's .git/worktrees/<name>) and has its own HEAD.
    const worktree = join(base, "worktree");
    const realGitDir = join(
      base,
      "main-repo",
      ".git",
      "worktrees",
      "my-worktree",
    );
    mkdirSync(worktree, { recursive: true });
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${realGitDir}\n`);
    writeFileSync(
      join(realGitDir, "HEAD"),
      "ref: refs/heads/feat/cli-fullscreen-tui-redesign\n",
    );

    const info = resolveGitInfo(worktree);
    // The WORKTREE's own directory is the root (not the main repo's location).
    expect(info?.root).toBe(worktree);
    expect(info?.branch).toBe("feat/cli-fullscreen-tui-redesign");
  });

  it("resolves a RELATIVE gitdir pointer against the .git file's own directory", () => {
    // Layout: <base>/worktree/.git (file) points at "../main-repo/.git/worktrees/w2",
    // which — resolved relative to <base>/worktree — is <base>/main-repo/.git/worktrees/w2.
    const worktree = join(base, "worktree");
    const realGitDir = join(base, "main-repo", ".git", "worktrees", "w2");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      "gitdir: ../main-repo/.git/worktrees/w2\n",
    );
    writeFileSync(
      join(realGitDir, "HEAD"),
      "ref: refs/heads/relative-pointer-branch\n",
    );

    expect(resolveGitInfo(worktree)?.branch).toBe("relative-pointer-branch");
  });

  it("walks up from a nested subdirectory INSIDE a worktree to find its root", () => {
    const worktree = join(base, "worktree");
    const realGitDir = join(base, "gitdir");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${realGitDir}\n`);
    writeFileSync(join(realGitDir, "HEAD"), "ref: refs/heads/main\n");
    const nested = join(worktree, "apps", "cli");
    mkdirSync(nested, { recursive: true });

    const info = resolveGitInfo(nested);
    expect(info?.root).toBe(worktree);
    expect(info?.branch).toBe("main");
  });
});

describe("resolveGitInfo — not a repo", () => {
  it("returns undefined when no .git exists anywhere up the chain", () => {
    // base is a fresh mkdtemp dir with nothing in it — no ancestor has a
    // .git either, since it's rooted under the OS temp dir.
    expect(resolveGitInfo(base)).toBeUndefined();
  });

  it("never throws — a malformed .git pointer degrades to undefined branch, not a crash", () => {
    writeFileSync(join(base, ".git"), "not a valid gitdir pointer at all");
    expect(() => resolveGitInfo(base)).not.toThrow();
    const info = resolveGitInfo(base);
    expect(info?.root).toBe(base);
    expect(info?.branch).toBeUndefined();
  });
});

describe("truncatePathStart", () => {
  it("returns the path unchanged when it already fits", () => {
    expect(truncatePathStart("/short/path", 40)).toBe("/short/path");
  });

  it("keeps the trailing (most identifying) segment, prefixed with an ellipsis", () => {
    const long = "/Users/mac/Workspaces/some/deeply/nested/path/oxagen-repl2";
    const truncated = truncatePathStart(long, 20);
    expect(truncated.length).toBe(20);
    expect(truncated.startsWith("…")).toBe(true);
    expect(truncated.endsWith("oxagen-repl2")).toBe(true);
  });

  it("is a no-op for a degenerate maxLen", () => {
    expect(truncatePathStart("/anything", 1)).toBe("/anything");
    expect(truncatePathStart("/anything", 0)).toBe("/anything");
  });
});

describe("abbreviateHome", () => {
  const home = homedir();

  it("replaces a leading $HOME with ~", () => {
    expect(abbreviateHome(join(home, "Workspaces", "oxagen-repl2"))).toBe(
      "~/Workspaces/oxagen-repl2",
    );
  });

  it("abbreviates $HOME itself to exactly ~", () => {
    expect(abbreviateHome(home)).toBe("~");
  });

  it("leaves a path outside $HOME unchanged", () => {
    expect(abbreviateHome("/var/tmp/somewhere")).toBe("/var/tmp/somewhere");
  });

  it("doesn't false-positive on a sibling directory that merely SHARES $HOME's prefix", () => {
    // e.g. $HOME=/Users/mac must not treat /Users/mac2/... as inside it.
    expect(abbreviateHome(home + "2/not-actually-home")).toBe(
      home + "2/not-actually-home",
    );
  });
});

describe("abbreviatePath", () => {
  const home = homedir();

  it("returns the $HOME-abbreviated form unchanged when it already fits", () => {
    const path = join(home, "oxagen-repl2");
    expect(abbreviatePath(path, 80)).toBe(abbreviateHome(path));
  });

  it("elides the middle down to the last segment when even the abbreviated form is too long", () => {
    const path = join(
      home,
      "Workspaces",
      "some",
      "deeply",
      "nested",
      "path",
      "oxagen-repl2",
    );
    const result = abbreviatePath(path, 20);
    expect(result).toBe("~/…/oxagen-repl2");
  });

  it("prefers keeping 2 trailing segments over 1 when both fit", () => {
    const path = join(
      home,
      "Workspaces",
      "some",
      "deeply",
      "nested",
      "oxagen-repl2",
      "apps",
    );
    const result = abbreviatePath(path, 30);
    expect(result).toBe("~/…/oxagen-repl2/apps");
  });

  it("falls back to plain character truncation when not even one segment fits", () => {
    const path = join(
      home,
      "a-genuinely-extremely-long-directory-name-that-cannot-fit",
    );
    const result = abbreviatePath(path, 10);
    expect(result.length).toBe(10);
    expect(result.startsWith("…")).toBe(true);
  });

  it("handles a path outside $HOME the same way, just without the ~ prefix", () => {
    // One character narrower than the ~-prefixed form (no "~" to budget for),
    // so at the same maxLen the last-2-segments form now fits where it didn't
    // for the $HOME case above.
    const result = abbreviatePath(
      "/var/data/some/deeply/nested/path/oxagen-repl2",
      20,
    );
    expect(result).toBe("/…/path/oxagen-repl2");
  });
});
