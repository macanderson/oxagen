/**
 * isGitRepo — proves the git-isolation-default-on fallback check: true only on
 * a clean zero-exit "true" answer from `git rev-parse --is-inside-work-tree`,
 * false on any non-zero exit or unexpected output. A fake {@link GitRunner} is
 * injected, so no real git process runs.
 */
import { describe, it, expect } from "vitest";
import { isGitRepo, type GitRunner } from "../fleet/git-isolation.js";

function fakeGit(result: { code: number; stdout: string }): GitRunner {
  return async () => ({ code: result.code, stdout: result.stdout, stderr: "" });
}

describe("isGitRepo", () => {
  it('is true when git exits 0 and reports "true"', async () => {
    await expect(
      isGitRepo("/repo", fakeGit({ code: 0, stdout: "true\n" })),
    ).resolves.toBe(true);
  });

  it("is false on a non-zero exit (not a git repository)", async () => {
    await expect(
      isGitRepo("/tmp/scratch", fakeGit({ code: 128, stdout: "" })),
    ).resolves.toBe(false);
  });

  it('is false when stdout doesn\'t say "true" even on exit 0', async () => {
    await expect(
      isGitRepo("/repo", fakeGit({ code: 0, stdout: "false\n" })),
    ).resolves.toBe(false);
  });
});
