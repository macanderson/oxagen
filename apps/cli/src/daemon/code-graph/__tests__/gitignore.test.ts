/**
 * Regression tests for `listSourceFiles` honoring `.gitignore`.
 *
 * The code-graph walker must NEVER index gitignored files. Before this fix it
 * recursed into nested worktrees under `.claude/worktrees/` (full copies of the
 * monorepo), inflating the index several-fold and stalling `init`. We now drive
 * file enumeration from git itself, so anything `.gitignore` excludes is never
 * read. Each test builds a throwaway git repo so it exercises the real
 * `git ls-files` path (no mocks).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { listSourceFiles } from "../builder";

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

describe("listSourceFiles — honors .gitignore", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "oxagen-codegraph-gi-"));
    git(repo, ["init", "-q"]);
    // Minimal identity so `git add` works inside CI sandboxes.
    git(repo, ["config", "user.email", "test@oxagen.test"]);
    git(repo, ["config", "user.name", "oxagen-test"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("includes tracked + untracked-non-ignored sources and excludes gitignored ones", async () => {
    writeFileSync(join(repo, ".gitignore"), "ignored.ts\nbuild/\n");
    writeFileSync(join(repo, "tracked.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "untracked.ts"), "export const b = 2;\n"); // untracked, NOT ignored
    writeFileSync(join(repo, "ignored.ts"), "export const c = 3;\n"); // ignored by name
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build", "out.ts"), "export const d = 4;\n"); // ignored dir
    git(repo, ["add", "tracked.ts"]);

    const files = await listSourceFiles(repo);

    expect(files).toContain("tracked.ts");
    expect(files).toContain("untracked.ts");
    expect(files).not.toContain("ignored.ts");
    expect(files).not.toContain(join("build", "out.ts"));
  });

  it("never descends into an ignored nested worktree dir (e.g. .claude/worktrees)", async () => {
    writeFileSync(join(repo, ".gitignore"), ".claude/\n");
    mkdirSync(join(repo, ".claude", "worktrees", "wt", "src"), {
      recursive: true,
    });
    writeFileSync(
      join(repo, ".claude", "worktrees", "wt", "src", "deep.ts"),
      "export const x = 1;\n",
    );
    writeFileSync(join(repo, "real.ts"), "export const y = 2;\n");

    const files = await listSourceFiles(repo);

    expect(files).toContain("real.ts");
    expect(files.some((f) => f.includes(".claude"))).toBe(false);
  });

  it("returns supported source + doc extensions, excludes the rest", async () => {
    writeFileSync(join(repo, "code.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "readme.md"), "# docs\n");
    writeFileSync(join(repo, "data.json"), "{}\n");

    const files = await listSourceFiles(repo);

    expect(files).toContain("code.ts");
    // .md/.mdx are indexed too — they carry a content embedding + domain like
    // any other file node (see builder.ts SUPPORTED_EXTENSIONS).
    expect(files).toContain("readme.md");
    expect(files).not.toContain("data.json");
  });
});
