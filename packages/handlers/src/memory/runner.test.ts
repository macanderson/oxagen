import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { FakeGitHub, REPO } from "../context.steering.test-support";
import { logger } from "../logger";
import { prepareBranch } from "./runner";

const BRANCH = "memory/2026-09-27";
/** The default branch's head when the curator planned the PR. */
const PLANNED = "base0";

describe("prepareBranch", () => {
  beforeEach(() => vi.mocked(logger.warn).mockClear());

  it("creates today's branch at the head the plan read", async () => {
    const gh = new FakeGitHub();
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
    expect(gh.resets).toEqual([]);
  });

  it("creates the branch at the planned head when the default branch moved after the plan", async () => {
    const gh = new FakeGitHub();
    gh.commit(REPO.defaultBranch, "steering/rules/new.md", "a merge");
    const branchHead = vi.spyOn(gh, "branchHead");
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
    // The host creates the branch at the planned commit in one call, so the
    // curator never reads it back or moves it.
    expect(gh.resets).toEqual([]);
    expect(branchHead).not.toHaveBeenCalled();
  });

  it("recreates a failed pass's branch at the planned head when the default branch moved", async () => {
    const gh = new FakeGitHub();
    await gh.ensureBranch(REPO, BRANCH, REPO.defaultBranch);
    gh.commit(BRANCH, "steering/memory/half.md", "a pass that failed");
    gh.commit(REPO.defaultBranch, "steering/rules/new.md", "a merge");
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.deletedBranches).toEqual([BRANCH]);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
    expect(gh.resets).toEqual([]);
  });

  it("replaces a branch a failed pass left without a PR", async () => {
    const gh = new FakeGitHub();
    await gh.ensureBranch(REPO, BRANCH, REPO.defaultBranch);
    gh.commit(BRANCH, "steering/memory/half.md", "a pass that failed");
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.deletedBranches).toEqual([BRANCH]);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
  });

  it("leaves a branch that already has an open PR", async () => {
    const gh = new FakeGitHub();
    await gh.ensureBranch(REPO, BRANCH, REPO.defaultBranch);
    const theirs = gh.commit(BRANCH, "steering/memory/theirs.md", "their PR");
    await gh.openPullRequest(REPO, {
      title: "Their memories",
      head: BRANCH,
      base: REPO.defaultBranch,
      body: "",
    });
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(false);
    expect(gh.deletedBranches).toEqual([]);
    expect(gh.heads.get(BRANCH)).toBe(theirs);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH }),
      expect.stringContaining("has an open PR"),
    );
  });
});
