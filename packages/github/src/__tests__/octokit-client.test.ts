import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createGitHubClient,
  type OctokitLike,
} from "../octokit-client";

// ---------------------------------------------------------------------------
// Fake Octokit builder
// ---------------------------------------------------------------------------

/** Build a fully-typed fake Octokit that callers can override per test. */
function buildFakeOctokit(overrides: Partial<OctokitLike> = {}): OctokitLike {
  const base: OctokitLike = {
    repos: {
      createInOrg: vi.fn().mockResolvedValue({
        data: {
          full_name: "acme/my-repo",
          html_url: "https://github.com/acme/my-repo",
          default_branch: "main",
        },
      }),
      get: vi.fn().mockResolvedValue({
        data: {
          full_name: "acme/forked-repo",
          html_url: "https://github.com/acme/forked-repo",
          default_branch: "main",
        },
      }),
      getContent: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })),
      createOrUpdateFileContents: vi.fn().mockResolvedValue({
        data: {
          commit: { sha: "abc123" },
          content: { html_url: "https://github.com/acme/my-repo/blob/main/README.md" },
        },
      }),
      createFork: vi.fn().mockResolvedValue({
        data: {
          full_name: "acme/forked-repo",
          html_url: "https://github.com/acme/forked-repo",
          default_branch: "main",
        },
      }),
    },
    git: {
      getRef: vi.fn().mockResolvedValue({
        data: { object: { sha: "deadbeef" } },
      }),
      createRef: vi.fn().mockResolvedValue({
        data: { ref: "refs/heads/feature-x", object: { sha: "deadbeef" } },
      }),
    },
    pulls: {
      create: vi.fn().mockResolvedValue({
        data: { number: 42, html_url: "https://github.com/acme/my-repo/pull/42" },
      }),
    },
    users: {
      getAuthenticated: vi.fn().mockResolvedValue({
        data: { login: "octocat" },
      }),
    },
  };

  // Shallow-merge overrides (per namespace)
  if (overrides.repos) Object.assign(base.repos, overrides.repos);
  if (overrides.git) Object.assign(base.git, overrides.git);
  if (overrides.pulls) Object.assign(base.pulls, overrides.pulls);
  if (overrides.users) Object.assign(base.users, overrides.users);

  return base;
}

// ---------------------------------------------------------------------------
// createRepoInOrg
// ---------------------------------------------------------------------------

describe("createRepoInOrg", () => {
  it("calls repos.createInOrg with the correct arguments", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    await client.createRepoInOrg({
      org: "acme",
      name: "my-repo",
      description: "A test repo",
      private: true,
      autoInit: true,
    });

    expect(fake.repos.createInOrg).toHaveBeenCalledWith({
      org: "acme",
      name: "my-repo",
      description: "A test repo",
      private: true,
      auto_init: true,
    });
  });

  it("maps the response to camelCase fields", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    const result = await client.createRepoInOrg({ org: "acme", name: "my-repo" });

    expect(result).toEqual({
      fullName: "acme/my-repo",
      htmlUrl: "https://github.com/acme/my-repo",
      defaultBranch: "main",
    });
  });

  it("omits optional keys when not provided", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    await client.createRepoInOrg({ org: "acme", name: "bare" });

    const callArgs = vi.mocked(fake.repos.createInOrg).mock.calls[0]![0];
    expect(callArgs).not.toHaveProperty("description");
    expect(callArgs).not.toHaveProperty("private");
    expect(callArgs).not.toHaveProperty("auto_init");
  });
});

// ---------------------------------------------------------------------------
// putFile — file absent
// ---------------------------------------------------------------------------

describe("putFile (file absent)", () => {
  it("does not pass sha when getContent returns 404", async () => {
    const fake = buildFakeOctokit({
      repos: {
        getContent: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({
          data: {
            commit: { sha: "abc123" },
            content: { html_url: "https://github.com/acme/my-repo/blob/main/README.md" },
          },
        }),
      } as Partial<OctokitLike["repos"]> as OctokitLike["repos"],
    });
    const client = createGitHubClient({ token: "tok" }, fake);

    await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "README.md",
      content: "hello world",
      message: "add readme",
    });

    const callArgs = vi.mocked(fake.repos.createOrUpdateFileContents).mock
      .calls[0]![0];
    expect(callArgs).not.toHaveProperty("sha");
  });

  it("base64-encodes the content string", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    const raw = "hello world";
    await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "file.txt",
      content: raw,
      message: "add file",
    });

    const callArgs = vi.mocked(fake.repos.createOrUpdateFileContents).mock
      .calls[0]![0];
    expect(callArgs.content).toBe(Buffer.from(raw).toString("base64"));
  });

  it("maps the response fields correctly", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    const result = await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "README.md",
      content: "hi",
      message: "init",
    });

    expect(result).toEqual({
      commitSha: "abc123",
      htmlUrl: "https://github.com/acme/my-repo/blob/main/README.md",
    });
  });
});

// ---------------------------------------------------------------------------
// putFile — file present (update path)
// ---------------------------------------------------------------------------

describe("putFile (file present)", () => {
  it("calls getContent first and passes the existing sha", async () => {
    const existingSha = "existing-sha-0001";
    const fake = buildFakeOctokit({
      repos: {
        getContent: vi.fn().mockResolvedValue({ data: { sha: existingSha } }),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({
          data: {
            commit: { sha: "new-commit-sha" },
            content: { html_url: "https://github.com/acme/my-repo/blob/main/README.md" },
          },
        }),
      } as Partial<OctokitLike["repos"]> as OctokitLike["repos"],
    });
    const client = createGitHubClient({ token: "tok" }, fake);

    await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "README.md",
      content: "updated",
      message: "update readme",
    });

    expect(fake.repos.getContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "my-repo",
      path: "README.md",
    });

    const updateArgs = vi.mocked(fake.repos.createOrUpdateFileContents).mock
      .calls[0]![0];
    expect(updateArgs.sha).toBe(existingSha);
  });

  it("passes the branch ref to getContent when provided", async () => {
    const fake = buildFakeOctokit({
      repos: {
        getContent: vi.fn().mockResolvedValue({ data: { sha: "branch-sha" } }),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({
          data: { commit: { sha: "c1" }, content: null },
        }),
      } as Partial<OctokitLike["repos"]> as OctokitLike["repos"],
    });
    const client = createGitHubClient({ token: "tok" }, fake);

    await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "file.ts",
      content: "code",
      message: "code update",
      branch: "feature-x",
    });

    expect(fake.repos.getContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "my-repo",
      path: "file.ts",
      ref: "feature-x",
    });
  });

  it("falls back to empty string htmlUrl when content is null", async () => {
    const fake = buildFakeOctokit({
      repos: {
        createOrUpdateFileContents: vi.fn().mockResolvedValue({
          data: { commit: { sha: "sha1" }, content: null },
        }),
      } as Partial<OctokitLike["repos"]> as OctokitLike["repos"],
    });
    const client = createGitHubClient({ token: "tok" }, fake);

    const result = await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "x",
      content: "y",
      message: "m",
    });

    expect(result.htmlUrl).toBe("");
  });
});

// ---------------------------------------------------------------------------
// forkRepo — immediate success
// ---------------------------------------------------------------------------

describe("forkRepo (fork immediately reachable)", () => {
  it("calls createFork then repos.get and returns mapped data", async () => {
    const fake = buildFakeOctokit({
      repos: {
        createFork: vi.fn().mockResolvedValue({
          data: {
            full_name: "myuser/orig-repo",
            html_url: "https://github.com/myuser/orig-repo",
            default_branch: "main",
          },
        }),
        get: vi.fn().mockResolvedValue({
          data: {
            full_name: "myuser/orig-repo",
            html_url: "https://github.com/myuser/orig-repo",
            default_branch: "main",
          },
        }),
      } as Partial<OctokitLike["repos"]> as OctokitLike["repos"],
    });
    const client = createGitHubClient({ token: "tok", sleepMs: 0 }, fake);

    const result = await client.forkRepo({ owner: "upstream", repo: "orig-repo" });

    expect(fake.repos.createFork).toHaveBeenCalledWith({
      owner: "upstream",
      repo: "orig-repo",
    });
    expect(fake.repos.get).toHaveBeenCalledWith({
      owner: "myuser",
      repo: "orig-repo",
    });
    expect(result).toEqual({
      fullName: "myuser/orig-repo",
      htmlUrl: "https://github.com/myuser/orig-repo",
      defaultBranch: "main",
    });
  });

  it("passes org when provided", async () => {
    const fake = buildFakeOctokit({
      repos: {
        createFork: vi.fn().mockResolvedValue({
          data: {
            full_name: "acme/orig-repo",
            html_url: "https://github.com/acme/orig-repo",
            default_branch: "main",
          },
        }),
        get: vi.fn().mockResolvedValue({
          data: {
            full_name: "acme/orig-repo",
            html_url: "https://github.com/acme/orig-repo",
            default_branch: "main",
          },
        }),
      } as Partial<OctokitLike["repos"]> as OctokitLike["repos"],
    });
    const client = createGitHubClient({ token: "tok", sleepMs: 0 }, fake);

    await client.forkRepo({ owner: "upstream", repo: "orig-repo", org: "acme" });

    expect(fake.repos.createFork).toHaveBeenCalledWith({
      owner: "upstream",
      repo: "orig-repo",
      organization: "acme",
    });
  });
});

// ---------------------------------------------------------------------------
// forkRepo — delayed (polling)
// ---------------------------------------------------------------------------

describe("forkRepo (delayed — polling)", () => {
  it("retries until repos.get succeeds after two 404s", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    // repos.get fails twice then succeeds
    const getFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }))
      .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }))
      .mockResolvedValueOnce({
        data: {
          full_name: "user/delayed-fork",
          html_url: "https://github.com/user/delayed-fork",
          default_branch: "main",
        },
      });

    const fake = buildFakeOctokit({
      repos: {
        createFork: vi.fn().mockResolvedValue({
          data: {
            full_name: "user/delayed-fork",
            html_url: "https://github.com/user/delayed-fork",
            default_branch: "main",
          },
        }),
        get: getFn,
      } as Partial<OctokitLike["repos"]> as OctokitLike["repos"],
    });

    const client = createGitHubClient(
      { token: "tok", sleepMs: 0, sleep: sleepFn },
      fake
    );

    const result = await client.forkRepo({
      owner: "upstream",
      repo: "delayed-fork",
    });

    // Should have been called 3 times (2 failures + 1 success)
    expect(getFn).toHaveBeenCalledTimes(3);
    // Sleep called after each failure (2 times)
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(result.fullName).toBe("user/delayed-fork");
  });

  it("falls back to fork data after 10 failed polls", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const fake = buildFakeOctokit({
      repos: {
        createFork: vi.fn().mockResolvedValue({
          data: {
            full_name: "user/never-ready",
            html_url: "https://github.com/user/never-ready",
            default_branch: "main",
          },
        }),
        get: vi.fn().mockRejectedValue(new Error("Not Found")),
      } as Partial<OctokitLike["repos"]> as OctokitLike["repos"],
    });

    const client = createGitHubClient(
      { token: "tok", sleepMs: 0, sleep: sleepFn },
      fake
    );

    const result = await client.forkRepo({ owner: "upstream", repo: "never-ready" });

    // 10 attempts, 9 sleeps (last attempt doesn't sleep)
    expect(vi.mocked(fake.repos.get)).toHaveBeenCalledTimes(10);
    expect(sleepFn).toHaveBeenCalledTimes(9);
    // Falls back to fork data
    expect(result.fullName).toBe("user/never-ready");
  });
});

// ---------------------------------------------------------------------------
// createBranch
// ---------------------------------------------------------------------------

describe("createBranch", () => {
  it("calls git.getRef with heads/<fromBranch> then git.createRef", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    const result = await client.createBranch({
      owner: "acme",
      repo: "my-repo",
      branch: "feature-x",
      fromBranch: "develop",
    });

    expect(fake.git.getRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "my-repo",
      ref: "heads/develop",
    });

    expect(fake.git.createRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "my-repo",
      ref: "refs/heads/feature-x",
      sha: "deadbeef",
    });

    expect(result).toEqual({ ref: "refs/heads/feature-x", sha: "deadbeef" });
  });

  it("defaults fromBranch to main when not specified", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    await client.createBranch({
      owner: "acme",
      repo: "my-repo",
      branch: "feature-y",
    });

    expect(fake.git.getRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "my-repo",
      ref: "heads/main",
    });
  });
});

// ---------------------------------------------------------------------------
// openPullRequest
// ---------------------------------------------------------------------------

describe("openPullRequest", () => {
  it("calls pulls.create with all required args", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    const result = await client.openPullRequest({
      owner: "acme",
      repo: "my-repo",
      title: "My PR",
      head: "feature-x",
      base: "main",
      body: "Description",
      draft: true,
    });

    expect(fake.pulls.create).toHaveBeenCalledWith({
      owner: "acme",
      repo: "my-repo",
      title: "My PR",
      head: "feature-x",
      base: "main",
      body: "Description",
      draft: true,
    });

    expect(result).toEqual({
      number: 42,
      htmlUrl: "https://github.com/acme/my-repo/pull/42",
    });
  });

  it("omits body and draft when not provided", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    await client.openPullRequest({
      owner: "acme",
      repo: "my-repo",
      title: "Minimal PR",
      head: "feature-x",
      base: "main",
    });

    const callArgs = vi.mocked(fake.pulls.create).mock.calls[0]![0];
    expect(callArgs).not.toHaveProperty("body");
    expect(callArgs).not.toHaveProperty("draft");
  });
});

// ---------------------------------------------------------------------------
// getAuthenticatedUser
// ---------------------------------------------------------------------------

describe("getAuthenticatedUser", () => {
  it("calls users.getAuthenticated and returns the login", async () => {
    const fake = buildFakeOctokit();
    const client = createGitHubClient({ token: "tok" }, fake);

    const result = await client.getAuthenticatedUser();

    expect(fake.users.getAuthenticated).toHaveBeenCalledOnce();
    expect(result).toEqual({ login: "octocat" });
  });
});
