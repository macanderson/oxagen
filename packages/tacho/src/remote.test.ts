// The remote rule both sides digest a repository by (#3941): the host from
// its `origin`, the control plane from the name a binding recorded.
import { describe, expect, it } from "vitest";
import { canonicalRemote, foldedRemote } from "./remote";

describe("canonicalRemote", () => {
  // A binding stores `github.com/acme/repo`. A remote that reduced to anything
  // else made a session in that bound repository ask `repo.unknown`.
  it("drops the port from a URL remote", () => {
    for (const form of [
      "ssh://git@github.com:22/acme/repo.git",
      "https://github.com:443/acme/repo.git",
      "ssh://git@GitHub.com:22/acme/repo",
    ])
      expect(canonicalRemote(form)).toBe("github.com/acme/repo");
    expect(canonicalRemote("ssh://git@[::1]:2222/acme/repo.git")).toBe(
      "[::1]/acme/repo",
    );
  });

  it("reads scp syntax with no user as the repository it names", () => {
    expect(canonicalRemote("github.com:acme/repo.git")).toBe(
      "github.com/acme/repo",
    );
    expect(foldedRemote(canonicalRemote("GitHub.com:Acme/Repo.git"))).toBe(
      "github.com/acme/repo",
    );
  });

  it("keeps a number after an scp colon in the path, since that syntax has no port (negative)", () => {
    expect(canonicalRemote("git@github.com:22/acme/repo.git")).toBe(
      "github.com/22/acme/repo",
    );
  });

  it("leaves a Windows drive path and a user-less form holding an @ as they were (negative)", () => {
    expect(canonicalRemote("C:/src/repo.git")).toBe("c:/src/repo");
    // Read as scp, this would move the token into the path.
    expect(canonicalRemote("user:ghp_secret@github.com/acme/repo.git")).toBe(
      "github.com/acme/repo",
    );
  });
});

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
