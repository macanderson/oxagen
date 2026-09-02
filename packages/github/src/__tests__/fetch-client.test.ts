import { afterEach, describe, it, expect, vi } from "vitest";
import { createGitHubClient } from "../fetch-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBody =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

function makeResponse(body: JsonBody, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// getAuthenticatedUser
// ---------------------------------------------------------------------------

describe("getAuthenticatedUser", () => {
  it("sends GET /user and returns login", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ login: "octocat" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.getAuthenticatedUser();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect(init.method).toBe("GET");
    expect(result).toEqual({ login: "octocat" });
  });

  it("sends the correct Authorization header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ login: "octocat" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "mytoken" });

    await client.getAuthenticatedUser();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer mytoken");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("uses baseUrl override when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ login: "enterprise-user" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({
      token: "tok",
      baseUrl: "https://github.enterprise.example.com/api/v3",
    });

    await client.getAuthenticatedUser();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.enterprise.example.com/api/v3/user");
  });
});

// ---------------------------------------------------------------------------
// createRepoInOrg
// ---------------------------------------------------------------------------

describe("createRepoInOrg", () => {
  it("sends POST /orgs/{org}/repos with correct body and maps response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        full_name: "acme/my-repo",
        html_url: "https://github.com/acme/my-repo",
        default_branch: "main",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.createRepoInOrg({
      org: "acme",
      name: "my-repo",
      description: "A test repo",
      private: true,
      autoInit: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/orgs/acme/repos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "my-repo",
      description: "A test repo",
      private: true,
      auto_init: true,
    });
    expect(result).toEqual({
      fullName: "acme/my-repo",
      htmlUrl: "https://github.com/acme/my-repo",
      defaultBranch: "main",
    });
  });

  it("omits optional fields when not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        full_name: "acme/bare",
        html_url: "https://github.com/acme/bare",
        default_branch: "main",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.createRepoInOrg({ org: "acme", name: "bare" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("private");
    expect(body).not.toHaveProperty("auto_init");
  });

  it("sends POST /user/repos when org is omitted (personal account)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        full_name: "macanderson/hello-world",
        html_url: "https://github.com/macanderson/hello-world",
        default_branch: "main",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.createRepoInOrg({
      name: "hello-world",
      autoInit: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user/repos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "hello-world",
      auto_init: true,
    });
    expect(result).toEqual({
      fullName: "macanderson/hello-world",
      htmlUrl: "https://github.com/macanderson/hello-world",
      defaultBranch: "main",
    });
  });
});

// ---------------------------------------------------------------------------
// putFile — file absent (404 on GET)
// ---------------------------------------------------------------------------

describe("putFile (file absent)", () => {
  it("does not include sha in PUT body when GET returns 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404)) // GET contents
      .mockResolvedValueOnce(
        makeResponse({
          // PUT contents
          commit: { sha: "abc123" },
          content: {
            html_url: "https://github.com/acme/my-repo/blob/main/README.md",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "README.md",
      content: "hello world",
      message: "add readme",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe(
      "https://api.github.com/repos/acme/my-repo/contents/README.md",
    );
    expect(putInit.method).toBe("PUT");
    const body = JSON.parse(putInit.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("sha");
  });

  it("base64-encodes the content string", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(
        makeResponse({
          commit: { sha: "abc123" },
          content: {
            html_url: "https://github.com/acme/my-repo/blob/main/f.txt",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const raw = "hello world";
    await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "f.txt",
      content: raw,
      message: "add file",
    });

    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(putInit.body as string) as Record<string, unknown>;
    expect(body["content"]).toBe(Buffer.from(raw, "utf8").toString("base64"));
  });

  it("maps the response fields correctly", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(
        makeResponse({
          commit: { sha: "abc123" },
          content: {
            html_url: "https://github.com/acme/my-repo/blob/main/README.md",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

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
  it("reads existing sha and includes it in the PUT body", async () => {
    const existingSha = "existing-sha-0001";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ sha: existingSha })) // GET contents
      .mockResolvedValueOnce(
        makeResponse({
          // PUT contents
          commit: { sha: "new-commit-sha" },
          content: {
            html_url: "https://github.com/acme/my-repo/blob/main/README.md",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "README.md",
      content: "updated",
      message: "update readme",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe(
      "https://api.github.com/repos/acme/my-repo/contents/README.md",
    );
    expect(getInit.method).toBe("GET");

    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(putInit.body as string) as Record<string, unknown>;
    expect(body["sha"]).toBe(existingSha);
  });

  it("passes branch ref as query param to GET and in PUT body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ sha: "branch-sha" }))
      .mockResolvedValueOnce(
        makeResponse({ commit: { sha: "c1" }, content: null }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.putFile({
      owner: "acme",
      repo: "my-repo",
      path: "file.ts",
      content: "code",
      message: "code update",
      branch: "feature-x",
    });

    const [getUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toContain("?ref=feature-x");

    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(putInit.body as string) as Record<string, unknown>;
    expect(body["branch"]).toBe("feature-x");
  });

  it("falls back to empty string htmlUrl when content is null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(
        makeResponse({ commit: { sha: "sha1" }, content: null }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

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
  it("posts to forks then polls GET until available", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // POST /forks
          full_name: "myuser/orig-repo",
          html_url: "https://github.com/myuser/orig-repo",
          default_branch: "main",
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          // GET /repos/myuser/orig-repo
          full_name: "myuser/orig-repo",
          html_url: "https://github.com/myuser/orig-repo",
          default_branch: "main",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok", sleepMs: 0 });

    const result = await client.forkRepo({
      owner: "upstream",
      repo: "orig-repo",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [forkUrl, forkInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(forkUrl).toBe(
      "https://api.github.com/repos/upstream/orig-repo/forks",
    );
    expect(forkInit.method).toBe("POST");

    const [pollUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(pollUrl).toBe("https://api.github.com/repos/myuser/orig-repo");

    expect(result).toEqual({
      fullName: "myuser/orig-repo",
      htmlUrl: "https://github.com/myuser/orig-repo",
      defaultBranch: "main",
    });
  });

  it("passes organization in the POST body when org is set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          full_name: "acme/orig-repo",
          html_url: "https://github.com/acme/orig-repo",
          default_branch: "main",
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          full_name: "acme/orig-repo",
          html_url: "https://github.com/acme/orig-repo",
          default_branch: "main",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok", sleepMs: 0 });

    await client.forkRepo({
      owner: "upstream",
      repo: "orig-repo",
      org: "acme",
    });

    const [, forkInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(forkInit.body as string) as Record<string, unknown>;
    expect(body["organization"]).toBe("acme");
  });
});

// ---------------------------------------------------------------------------
// forkRepo — delayed (polling)
// ---------------------------------------------------------------------------

describe("forkRepo (delayed — polling)", () => {
  it("retries until GET succeeds after two 404s", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // POST /forks
          full_name: "user/delayed-fork",
          html_url: "https://github.com/user/delayed-fork",
          default_branch: "main",
        }),
      )
      .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404)) // poll 1
      .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404)) // poll 2
      .mockResolvedValueOnce(
        makeResponse({
          // poll 3 success
          full_name: "user/delayed-fork",
          html_url: "https://github.com/user/delayed-fork",
          default_branch: "main",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({
      token: "tok",
      sleepMs: 0,
      sleep: sleepFn,
    });

    const result = await client.forkRepo({
      owner: "upstream",
      repo: "delayed-fork",
    });

    // POST + 3 polls (2 fail, 1 success)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Sleep called after each failure
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(result.fullName).toBe("user/delayed-fork");
  });

  it("falls back to fork data after 10 failed polls", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        // POST /forks
        full_name: "user/never-ready",
        html_url: "https://github.com/user/never-ready",
        default_branch: "main",
      }),
    );
    // All 10 polls fail
    for (let i = 0; i < 10; i++) {
      fetchMock.mockResolvedValueOnce(
        makeResponse({ message: "Not Found" }, 404),
      );
    }
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({
      token: "tok",
      sleepMs: 0,
      sleep: sleepFn,
    });

    const result = await client.forkRepo({
      owner: "upstream",
      repo: "never-ready",
    });

    // POST + 10 polls
    expect(fetchMock).toHaveBeenCalledTimes(11);
    // 9 sleeps (last attempt doesn't sleep)
    expect(sleepFn).toHaveBeenCalledTimes(9);
    expect(result.fullName).toBe("user/never-ready");
  });
});

// ---------------------------------------------------------------------------
// createBranch
// ---------------------------------------------------------------------------

describe("createBranch", () => {
  it("uses GET ref and POST refs with specified fromBranch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          ref: "refs/heads/develop",
          object: { sha: "deadbeef" },
        }),
      ) // GET ref
      .mockResolvedValueOnce(
        makeResponse({
          ref: "refs/heads/feature-x",
          object: { sha: "deadbeef" },
        }),
      ); // POST refs
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.createBranch({
      owner: "acme",
      repo: "my-repo",
      branch: "feature-x",
      fromBranch: "develop",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [refUrl, refInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(refUrl).toBe(
      "https://api.github.com/repos/acme/my-repo/git/ref/heads/develop",
    );
    expect(refInit.method).toBe("GET");

    const [postUrl, postInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(postUrl).toBe("https://api.github.com/repos/acme/my-repo/git/refs");
    expect(JSON.parse(postInit.body as string)).toEqual({
      ref: "refs/heads/feature-x",
      sha: "deadbeef",
    });

    expect(result).toEqual({ ref: "refs/heads/feature-x", sha: "deadbeef" });
  });

  it("fetches repo to discover default_branch when fromBranch is omitted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          // GET repo
          full_name: "acme/my-repo",
          html_url: "https://github.com/acme/my-repo",
          default_branch: "trunk",
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({ ref: "refs/heads/trunk", object: { sha: "deadbeef" } }),
      ) // GET ref
      .mockResolvedValueOnce(
        makeResponse({
          ref: "refs/heads/feature-y",
          object: { sha: "deadbeef" },
        }),
      ); // POST refs
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.createBranch({
      owner: "acme",
      repo: "my-repo",
      branch: "feature-y",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [repoUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(repoUrl).toBe("https://api.github.com/repos/acme/my-repo");

    const [refUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(refUrl).toBe(
      "https://api.github.com/repos/acme/my-repo/git/ref/heads/trunk",
    );
  });
});

// ---------------------------------------------------------------------------
// openPullRequest
// ---------------------------------------------------------------------------

describe("openPullRequest", () => {
  it("sends POST /pulls with all args and maps response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        number: 42,
        html_url: "https://github.com/acme/my-repo/pull/42",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.openPullRequest({
      owner: "acme",
      repo: "my-repo",
      title: "My PR",
      head: "feature-x",
      base: "main",
      body: "Description",
      draft: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/my-repo/pulls");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
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
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        number: 1,
        html_url: "https://github.com/acme/my-repo/pull/1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.openPullRequest({
      owner: "acme",
      repo: "my-repo",
      title: "Minimal PR",
      head: "feature-x",
      base: "main",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const reqBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(reqBody).not.toHaveProperty("body");
    expect(reqBody).not.toHaveProperty("draft");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("throws an Error including the status on a non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({ message: "Repository not found" }, 404),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await expect(client.getAuthenticatedUser()).rejects.toThrow("404");
  });

  it("includes the GitHub error message in the thrown error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ message: "Bad credentials" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "bad" });

    await expect(client.getAuthenticatedUser()).rejects.toThrow(
      "Bad credentials",
    );
  });
});

// ---------------------------------------------------------------------------
// getFileContent
// ---------------------------------------------------------------------------

describe("getFileContent", () => {
  it("GET /repos/{owner}/{repo}/contents/{path} and base64-decodes the content", async () => {
    const raw = "hello world";
    const encoded = Buffer.from(raw, "utf8").toString("base64");
    // GitHub API returns content with embedded newlines; include one to verify
    // we strip them before decoding.
    const contentWithNewline = encoded.slice(0, 4) + "\n" + encoded.slice(4);

    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        type: "file",
        encoding: "base64",
        content: contentWithNewline,
        sha: "abc123",
        path: "README.md",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.getFileContent({
      owner: "acme",
      repo: "my-repo",
      path: "README.md",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/acme/my-repo/contents/README.md",
    );
    expect((init as RequestInit).method).toBe("GET");
    expect(result).toBe("hello world");
  });

  it("appends ?ref= when ref is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from("x", "utf8").toString("base64"),
        sha: "sha1",
        path: "x.ts",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.getFileContent({
      owner: "acme",
      repo: "r",
      path: "x.ts",
      ref: "feature-branch",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("?ref=feature-branch");
  });

  it("returns null on 404 without throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.getFileContent({
      owner: "acme",
      repo: "r",
      path: "missing.ts",
    });

    expect(result).toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({ message: "Internal Server Error" }, 500),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await expect(
      client.getFileContent({ owner: "acme", repo: "r", path: "x.ts" }),
    ).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// getTree
// ---------------------------------------------------------------------------

describe("getTree", () => {
  it("resolves branch→tree SHA then fetches recursive tree and returns blob paths", async () => {
    const fetchMock = vi
      .fn()
      // GET /repos/acme/r/branches/main
      .mockResolvedValueOnce(
        makeResponse({
          commit: {
            sha: "commit-sha-1",
            commit: { tree: { sha: "tree-sha-1" } },
          },
        }),
      )
      // GET /repos/acme/r/git/trees/tree-sha-1?recursive=1
      .mockResolvedValueOnce(
        makeResponse({
          tree: [
            { path: "src/index.ts", type: "blob", sha: "b1" },
            { path: "src/lib", type: "tree", sha: "t1" },
            { path: "src/lib/util.ts", type: "blob", sha: "b2" },
            { path: "README.md", type: "blob", sha: "b3" },
          ],
          truncated: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.getTree({
      owner: "acme",
      repo: "r",
      ref: "main",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [branchUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(branchUrl).toBe("https://api.github.com/repos/acme/r/branches/main");

    const [treeUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(treeUrl).toBe(
      "https://api.github.com/repos/acme/r/git/trees/tree-sha-1?recursive=1",
    );

    // Only blobs are returned (tree entries filtered out)
    expect(result).toEqual(["src/index.ts", "src/lib/util.ts", "README.md"]);
  });

  it("defaults ref to 'main' when not provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          commit: {
            sha: "cs1",
            commit: { tree: { sha: "ts1" } },
          },
        }),
      )
      .mockResolvedValueOnce(makeResponse({ tree: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await client.getTree({ owner: "acme", repo: "r" });

    const [branchUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(branchUrl).toContain("/branches/main");
  });

  it("returns empty array when tree has no blobs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          commit: { sha: "cs", commit: { tree: { sha: "ts" } } },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          tree: [{ path: "src", type: "tree", sha: "t1" }],
          truncated: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.getTree({
      owner: "acme",
      repo: "r",
      ref: "main",
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getRepoInfo
// ---------------------------------------------------------------------------

describe("getRepoInfo", () => {
  it("sends GET /repos/{owner}/{repo} and maps the repo fields", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({
        full_name: "acme/widgets",
        html_url: "https://github.com/acme/widgets",
        default_branch: "develop",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    const result = await client.getRepoInfo({ owner: "acme", repo: "widgets" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets");
    expect(init.method).toBe("GET");
    expect(result).toEqual({
      fullName: "acme/widgets",
      htmlUrl: "https://github.com/acme/widgets",
      defaultBranch: "develop",
    });
  });

  it("propagates API errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient({ token: "tok" });

    await expect(
      client.getRepoInfo({ owner: "acme", repo: "missing" }),
    ).rejects.toThrow();
  });
});
