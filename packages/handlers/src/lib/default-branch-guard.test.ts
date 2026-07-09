import { describe, it, expect, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import { assertNonDefaultBranchWrite } from "./default-branch-guard";

function reader(defaultBranch: string) {
  return {
    getRepoInfo: vi.fn().mockResolvedValue({ defaultBranch }),
  };
}

describe("assertNonDefaultBranchWrite", () => {
  it("returns the default branch for a non-default target", async () => {
    const gh = reader("main");

    const result = await assertNonDefaultBranchWrite(gh, {
      owner: "o",
      repo: "r",
      branch: "feat/topic",
      capability: "put_repo_file",
    });

    expect(result).toBe("main");
    expect(gh.getRepoInfo).toHaveBeenCalledWith({ owner: "o", repo: "r" });
  });

  it("throws 403 when the branch is omitted (would silently target the default branch)", async () => {
    const gh = reader("develop");

    const err = await assertNonDefaultBranchWrite(gh, {
      owner: "o",
      repo: "r",
      branch: undefined,
      capability: "put_repo_file",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(403);
    expect((err as HTTPException).message).toContain("put_repo_file");
    expect((err as HTTPException).message).toContain('"develop"');
    expect((err as HTTPException).message).toContain("create_branch");
  });

  it("throws 403 when the branch names the default branch", async () => {
    const gh = reader("main");

    const err = await assertNonDefaultBranchWrite(gh, {
      owner: "o",
      repo: "r",
      branch: "main",
      capability: "create_branch",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(403);
    expect((err as HTTPException).message).toContain("create_branch");
    expect((err as HTTPException).message).toContain("open_pr");
  });

  it("treats an empty-string branch as omitted", async () => {
    const gh = reader("main");

    await expect(
      assertNonDefaultBranchWrite(gh, {
        owner: "o",
        repo: "r",
        branch: "",
        capability: "put_repo_file",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("propagates repo-lookup failures instead of failing open", async () => {
    const gh = {
      getRepoInfo: vi.fn().mockRejectedValue(new Error("GitHub API error 500")),
    };

    await expect(
      assertNonDefaultBranchWrite(gh, {
        owner: "o",
        repo: "r",
        branch: "feat/topic",
        capability: "put_repo_file",
      }),
    ).rejects.toThrow("GitHub API error 500");
  });
});
