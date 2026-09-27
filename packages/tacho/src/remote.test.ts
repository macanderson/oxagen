// The remote rule both sides digest a repository by (#3941): the host from
// its `origin`, the control plane from the name a binding recorded.
import { describe, expect, it } from "vitest";
import { canonicalRemote, foldedRemote } from "./remote";

describe("foldedRemote", () => {
  it("lowercases the path on a forge that ignores its case", () => {
    expect(foldedRemote(canonicalRemote("git@github.com:Acme/Repo.git"))).toBe(
      "github.com/acme/repo",
    );
    expect(foldedRemote("gitlab.com/Group/Sub/Project")).toBe(
      "gitlab.com/group/sub/project",
    );
  });

  it("folds two spellings of one GitHub repository onto one value", () => {
    const forms = [
      "git@github.com:Acme/Repo.git",
      "https://github.com/acme/repo",
      "https://token@GitHub.com/ACME/REPO.git",
    ];
    expect(new Set(forms.map((f) => foldedRemote(canonicalRemote(f))))).toEqual(
      new Set(["github.com/acme/repo"]),
    );
  });

  it("keeps the path's case on any other host (negative)", () => {
    expect(foldedRemote("git.example.com/Team/Tool")).toBe(
      "git.example.com/Team/Tool",
    );
  });

  it("leaves a remote with no path as it is", () => {
    expect(foldedRemote("github.com")).toBe("github.com");
  });
});
