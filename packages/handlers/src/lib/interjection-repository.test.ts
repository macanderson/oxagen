// The repository a host's question is about, found by its digest (#3941):
// the control plane digests each repository the workspace's installation can
// see exactly as the host digests its remote, so every remote form a host
// may hold (scp, https, a token in the userinfo, another case) finds its
// repository, and nothing else does.
import { describe, expect, it, vi } from "vitest";
import { canonicalRemote, digestBytes, foldedRemote } from "@oxagen/tacho";

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  type InterjectionRepositoryDeps,
  matchRepository,
  repositoryDigests,
  resolveInterjectionRepository,
} from "./interjection-repository";

/** The digests a host sends for its `origin` remote. */
function hostDigests(remote: string) {
  const canonical = canonicalRemote(remote);
  return {
    remote_digest: digestBytes(canonical),
    remote_digest_folded: digestBytes(foldedRemote(canonical)),
  };
}

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

function repo(fullName: string) {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    id: fullName,
    owner,
    name,
    fullName,
    defaultBranch: "main",
    private: true,
    htmlUrl: `https://github.com/${fullName}`,
  };
}

function deps(
  installationId: string | null,
  fullNames: string[],
  truncated = false,
) {
  return {
    installation: async () => installationId,
    repositories: vi.fn<InterjectionRepositoryDeps["repositories"]>(
      async () => ({ repositories: fullNames.map(repo), truncated }),
    ),
  };
}

describe("matchRepository", () => {
  const listed = ["acme/web", "acme/api", "other/api"];

  it("finds the repository for every remote form a host may hold", () => {
    for (const remote of [
      "git@github.com:acme/api.git",
      "https://github.com/acme/api.git",
      "https://x-access-token:ghs_secret@github.com/acme/api.git",
      "ssh://git@github.com/acme/api",
      "https://github.com/acme/api/",
    ])
      expect(matchRepository(listed, hostDigests(remote)), remote).toBe(
        "acme/api",
      );
  });

  it("finds a repository whose remote differs only in case, through the folded digest", () => {
    expect(
      matchRepository(listed, hostDigests("https://github.com/Acme/API.git")),
    ).toBe("acme/api");
  });

  it("finds nothing for a remote the list does not hold, or a case the host did not fold (negative)", () => {
    expect(
      matchRepository(listed, hostDigests("git@github.com:acme/cli.git")),
    ).toBeNull();
    const { remote_digest } = hostDigests("https://github.com/Acme/API.git");
    expect(matchRepository(listed, { remote_digest })).toBeNull();
    expect(
      matchRepository(listed, hostDigests("git@gitlab.com:acme/api.git")),
    ).toBeNull();
  });

  it("digests a listed repository both ways, as the bundle digests a bound one", () => {
    expect(repositoryDigests("Acme/API")).toEqual([
      digestBytes("github.com/Acme/API"),
      digestBytes("github.com/acme/api"),
    ]);
  });
});

describe("resolveInterjectionRepository", () => {
  const remote = hostDigests("git@github.com:acme/api.git");

  it("answers the matching repository the workspace's installation reaches", async () => {
    const d = deps("123", ["acme/web", "acme/api"]);
    await expect(resolveInterjectionRepository(SCOPE, remote, d)).resolves.toBe(
      "acme/api",
    );
    expect(d.repositories).toHaveBeenCalledWith("123");
  });

  it("answers null for a workspace with no installation, and reads nothing from GitHub (negative)", async () => {
    const d = deps(null, ["acme/api"]);
    await expect(
      resolveInterjectionRepository(SCOPE, remote, d),
    ).resolves.toBeNull();
    expect(d.repositories).not.toHaveBeenCalled();
  });

  it("answers null when the installation reaches no match, even a listing cut short (negative)", async () => {
    await expect(
      resolveInterjectionRepository(SCOPE, remote, deps("123", [], true)),
    ).resolves.toBeNull();
  });

  it("lets a GitHub failure through for the caller to decide", async () => {
    const d: InterjectionRepositoryDeps = {
      installation: async () => "123",
      repositories: () => Promise.reject(new Error("github 502")),
    };
    await expect(resolveInterjectionRepository(SCOPE, remote, d)).rejects.toThrow(
      "github 502",
    );
  });
});
