import { describe, expect, it } from "vitest";
import { repoBranchList } from "./repo.branch.list";
import { getCapability } from "../registry";

describe("repo.branch.list capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("accepts a valid owner and repo", () => {
    const parsed = repoBranchList.input.parse({
      owner: "myorg",
      repo: "myrepo",
    });
    expect(parsed.owner).toBe("myorg");
    expect(parsed.repo).toBe("myrepo");
  });

  it("rejects input missing owner", () => {
    expect(() => repoBranchList.input.parse({ repo: "myrepo" })).toThrow();
  });

  it("rejects input missing repo", () => {
    expect(() => repoBranchList.input.parse({ owner: "myorg" })).toThrow();
  });

  // ── output: branches array ────────────────────────────────────────────────

  it("parses a full valid output with branches and a resolved default", () => {
    const parsed = repoBranchList.output.parse({
      branches: [
        { name: "main", sha: "abc123", isDefault: true, protected: true },
        {
          name: "feature/x",
          sha: "def456",
          isDefault: false,
          protected: false,
        },
      ],
      defaultBranch: "main",
    });
    expect(parsed.branches).toHaveLength(2);
    expect(parsed.branches[0]).toEqual({
      name: "main",
      sha: "abc123",
      isDefault: true,
      protected: true,
    });
    expect(parsed.defaultBranch).toBe("main");
  });

  it("parses an empty branches array (empty repo)", () => {
    const parsed = repoBranchList.output.parse({
      branches: [],
      defaultBranch: "main",
    });
    expect(parsed.branches).toEqual([]);
  });

  it("accepts a null defaultBranch when it could not be resolved", () => {
    const parsed = repoBranchList.output.parse({
      branches: [
        { name: "main", sha: "abc123", isDefault: false, protected: false },
      ],
      defaultBranch: null,
    });
    expect(parsed.defaultBranch).toBeNull();
  });

  it("rejects a branch entry missing protected", () => {
    expect(() =>
      repoBranchList.output.parse({
        branches: [{ name: "main", sha: "abc123", isDefault: true }],
        defaultBranch: "main",
      }),
    ).toThrow();
  });

  it("rejects output missing branches", () => {
    expect(() =>
      repoBranchList.output.parse({ defaultBranch: "main" }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_branches")).toBe(repoBranchList);
  });
});
