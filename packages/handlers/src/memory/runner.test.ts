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

/** Run `during` after the curator reads the new branch's head, before it resets it. */
function afterBranchRead(gh: FakeGitHub, during: () => Promise<void>): void {
  const read = gh.branchHead.bind(gh);
  gh.branchHead = async (repo, branch) => {
    const sha = await read(repo, branch);
    if (branch === BRANCH) await during();
    return sha;
  };
}

describe("prepareBranch", () => {
  beforeEach(() => vi.mocked(logger.warn).mockClear());

  it("creates today's branch at the head the plan read", async () => {
    const gh = new FakeGitHub();
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
    expect(gh.resets).toEqual([]);
  });

  it("moves the branch back to the planned head when the default branch moved after the plan", async () => {
    const gh = new FakeGitHub();
    gh.commit(REPO.defaultBranch, "steering/rules/new.md", "a merge");
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
    expect(gh.resets).toEqual([{ branch: BRANCH, sha: PLANNED }]);
  });

  it("leaves the branch alone when someone pushes to it while the curator sets it up", async () => {
    const gh = new FakeGitHub();
    gh.commit(REPO.defaultBranch, "steering/rules/new.md", "a merge");
    let pushed = "";
    afterBranchRead(gh, async () => {
      pushed = gh.commit(BRANCH, "steering/memory/theirs.md", "their push");
    });
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(false);
    expect(gh.heads.get(BRANCH)).toBe(pushed);
    expect(gh.resets).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH, head: PLANNED }),
      expect.stringContaining("moved while the curator set it up"),
    );
  });

  it("returns false when the branch is deleted while the curator sets it up", async () => {
    const gh = new FakeGitHub();
    const read = gh.branchHead.bind(gh);
    gh.branchHead = async (repo, branch) => {
      if (branch === BRANCH) await gh.deleteBranch(repo, branch);
      return read(repo, branch);
    };
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(false);
    expect(gh.heads.has(BRANCH)).toBe(false);
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
  });
});
