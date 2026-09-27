import { describe, expect, it, vi } from "vitest";
import { createGitLabClient, GitLabApiError } from "./client";

const TOKEN = "glpat-SECRET-token-value";
const BASE = "https://gitlab.test";
const API = `${BASE}/api/v4`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

function reply(r: Reply): Response {
  const status = r.status ?? 200;
  const payload =
    status === 204
      ? null
      : r.text !== undefined
        ? r.text
        : JSON.stringify(r.body ?? {});
  return new Response(payload, {
    status,
    statusText: status >= 400 ? "Bad Thing" : "OK",
    headers: r.headers,
  });
}

/** A fake fetch that answers each call with the next reply and records the request. */
function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fn = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const next = replies.shift();
      if (!next) throw new Error("unexpected fetch");
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return reply(next);
    },
  );
  return { fetch: fn as unknown as typeof fetch, calls };
}

function client(...replies: Reply[]) {
  const f = fakeFetch(...replies);
  const sleep = vi.fn(async () => {});
  const c = createGitLabClient({
    token: TOKEN,
    baseUrl: `${BASE}/`,
    fetch: f.fetch,
    sleep,
  });
  return { c, calls: f.calls, sleep };
}

const MR = {
  iid: 7,
  project_id: 42,
  web_url: "https://gitlab.test/g/p/-/merge_requests/7",
  title: "Update steering",
  description: "body",
  state: "opened",
  source_branch: "oxagen/steer",
  target_branch: "main",
  sha: "abc123",
  merge_commit_sha: null,
  squash_commit_sha: null,
  merged_at: null,
  detailed_merge_status: "mergeable",
};

const MAPPED_MR = {
  iid: 7,
  webUrl: "https://gitlab.test/g/p/-/merge_requests/7",
  title: "Update steering",
  description: "body",
  state: "opened",
  sourceBranch: "oxagen/steer",
  targetBranch: "main",
  sha: "abc123",
  mergeCommitSha: null,
  squashCommitSha: null,
  mergedAt: null,
  detailedMergeStatus: "mergeable",
  projectId: "42",
};

describe("createGitLabClient", () => {
  it("refuses an empty token", () => {
    expect(() => createGitLabClient({ token: " " })).toThrow(TypeError);
  });

  it("refuses a negative maxRetries", () => {
    expect(() => createGitLabClient({ token: TOKEN, maxRetries: -1 })).toThrow(
      /maxRetries/,
    );
  });

  it("defaults to gitlab.com and the global fetch", async () => {
    const f = fakeFetch({ body: { id: 1, username: "u" } });
    vi.stubGlobal("fetch", f.fetch);
    try {
      await createGitLabClient({ token: TOKEN }).getCurrentUser();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(f.calls[0]?.url).toBe("https://gitlab.com/api/v4/user");
  });
});

describe("request headers", () => {
  it("sends the token only in PRIVATE-TOKEN, never in the URL", async () => {
    const { c, calls } = client({ body: { id: 1, username: "u" } });
    await c.getCurrentUser();
    expect(calls[0]?.headers["PRIVATE-TOKEN"]).toBe(TOKEN);
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("sets Content-Type on JSON requests", async () => {
    const { c, calls } = client({ status: 201, body: {} });
    await c.createBranch({ project: 1, branch: "b", ref: "main" });
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  });
});

describe("project references", () => {
  it("passes a numeric id through", async () => {
    const { c, calls } = client(
      {
        body: {
          id: 1,
          path: "p",
          path_with_namespace: "g/p",
          namespace: { full_path: "g" },
          web_url: "w",
        },
      },
      {
        body: {
          id: 1,
          path: "p",
          path_with_namespace: "g/p",
          namespace: { full_path: "g" },
          web_url: "w",
        },
      },
    );
    await c.getProject(1234);
    await c.getProject("1234");
    expect(calls.map((x) => x.url)).toEqual([
      `${API}/projects/1234`,
      `${API}/projects/1234`,
    ]);
  });

  it("encodes a full path into one segment", async () => {
    const { c, calls } = client({
      body: {
        id: 1,
        path: "p",
        path_with_namespace: "a/b/c",
        namespace: { full_path: "a/b" },
        web_url: "w",
      },
    });
    await c.getProject("a/b/c");
    expect(calls[0]?.url).toBe(`${API}/projects/a%2Fb%2Fc`);
  });

  it("refuses dot segments, empty paths, and bad numeric ids", async () => {
    const { c } = client();
    await expect(c.getProject("..")).rejects.toThrow(TypeError);
    await expect(c.getProject("")).rejects.toThrow(TypeError);
    await expect(c.getProject(0)).rejects.toThrow(TypeError);
    await expect(c.getProject(1.5)).rejects.toThrow(TypeError);
  });
});

describe("getProject", () => {
  it("maps the project", async () => {
    const { c, calls } = client({
      body: {
        id: 42,
        path: "proj",
        path_with_namespace: "grp/sub/proj",
        namespace: { full_path: "grp/sub" },
        default_branch: "main",
        web_url: "https://gitlab.test/grp/sub/proj",
        archived: false,
      },
    });
    expect(await c.getProject(42)).toEqual({
      id: "42",
      pathWithNamespace: "grp/sub/proj",
      namespaceFullPath: "grp/sub",
      path: "proj",
      defaultBranch: "main",
      webUrl: "https://gitlab.test/grp/sub/proj",
      archived: false,
    });
    expect(calls[0]?.method).toBe("GET");
  });

  it("maps an empty project with no default branch", async () => {
    const { c } = client({
      body: {
        id: 1,
        path: "p",
        path_with_namespace: "g/p",
        namespace: { full_path: "g" },
        web_url: "w",
        archived: true,
      },
    });
    const p = await c.getProject(1);
    expect(p.defaultBranch).toBeNull();
    expect(p.archived).toBe(true);
  });
});

describe("getCurrentToken", () => {
  it("reads /personal_access_tokens/self", async () => {
    const { c, calls } = client({
      body: {
        id: 9,
        name: "oxagen",
        scopes: ["api"],
        active: true,
        revoked: false,
        expires_at: "2027-01-01",
      },
    });
    expect(await c.getCurrentToken()).toEqual({
      id: 9,
      name: "oxagen",
      scopes: ["api"],
      active: true,
      revoked: false,
      expiresAt: "2027-01-01",
    });
    expect(calls[0]?.url).toBe(`${API}/personal_access_tokens/self`);
  });

  it("defaults missing scopes and expiry", async () => {
    const { c } = client({
      body: { id: 9, name: "n", active: false, revoked: true },
    });
    const t = await c.getCurrentToken();
    expect(t.scopes).toEqual([]);
    expect(t.expiresAt).toBeNull();
  });
});

describe("getCurrentUser", () => {
  it("maps bot only when GitLab says true", async () => {
    const { c, calls } = client(
      { body: { id: 5, username: "project_42_bot", bot: true } },
      { body: { id: 6, username: "human" } },
    );
    expect(await c.getCurrentUser()).toEqual({
      id: 5,
      username: "project_42_bot",
      bot: true,
    });
    expect((await c.getCurrentUser()).bot).toBe(false);
    expect(calls[0]?.url).toBe(`${API}/user`);
  });
});

describe("getFileRaw", () => {
  it("returns the raw text and encodes the file path", async () => {
    const { c, calls } = client({ text: "# rules\n" });
    const text = await c.getFileRaw({
      project: 42,
      path: ".oxagen/rules/a b.md",
      ref: "main",
    });
    expect(text).toBe("# rules\n");
    expect(calls[0]?.url).toBe(
      `${API}/projects/42/repository/files/.oxagen%2Frules%2Fa%20b.md/raw?ref=main`,
    );
  });

  it("returns null on 404", async () => {
    const { c } = client({
      status: 404,
      body: { message: "404 File Not Found" },
    });
    expect(
      await c.getFileRaw({ project: 1, path: "x", ref: "main" }),
    ).toBeNull();
  });

  it("rethrows other failures", async () => {
    const { c } = client({ status: 403, body: { message: "403 Forbidden" } });
    await expect(
      c.getFileRaw({ project: 1, path: "x", ref: "main" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("listPathCommits", () => {
  it("maps commits and uses the first line as the summary", async () => {
    const { c, calls } = client({
      body: [
        {
          id: "sha1",
          title: "Tighten rule",
          message: "Tighten rule\n\nlong body",
          author_name: "Ada",
          author_email: "ada@example.com",
          authored_date: "2026-09-01T00:00:00Z",
        },
        {
          id: "sha2",
          message: "First\nsecond",
          author_name: "Bob",
          authored_date: "2026-08-01T00:00:00Z",
        },
      ],
    });
    const commits = await c.listPathCommits({
      project: "g/p",
      path: "AGENTS.md",
      ref: "main",
      limit: 5,
    });
    expect(commits).toEqual([
      {
        sha: "sha1",
        authorName: "Ada",
        authorEmail: "ada@example.com",
        committedAt: "2026-09-01T00:00:00Z",
        summary: "Tighten rule",
      },
      {
        sha: "sha2",
        authorName: "Bob",
        authorEmail: null,
        committedAt: "2026-08-01T00:00:00Z",
        summary: "First",
      },
    ]);
    expect(calls[0]?.url).toBe(
      `${API}/projects/g%2Fp/repository/commits?ref_name=main&path=AGENTS.md&per_page=5`,
    );
  });

  it("caps per_page at 100 and returns nothing for a zero limit", async () => {
    const { c, calls } = client({ body: [] });
    await c.listPathCommits({ project: 1, path: "a", ref: "m", limit: 500 });
    expect(calls[0]?.url).toContain("per_page=100");
    expect(
      await c.listPathCommits({ project: 1, path: "a", ref: "m", limit: 0 }),
    ).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("gives an empty summary when GitLab sends no title or message", async () => {
    const { c } = client({
      body: [{ id: "s", author_name: "A", authored_date: "d" }],
    });
    const [commit] = await c.listPathCommits({
      project: 1,
      path: "a",
      ref: "m",
      limit: 1,
    });
    expect(commit?.summary).toBe("");
  });
});

describe("branches", () => {
  it("getBranch encodes the name and maps the head", async () => {
    const { c, calls } = client({
      body: { name: "feat/x", commit: { id: "head1" } },
    });
    expect(await c.getBranch({ project: 1, branch: "feat/x" })).toEqual({
      name: "feat/x",
      commitSha: "head1",
    });
    expect(calls[0]?.url).toBe(
      `${API}/projects/1/repository/branches/feat%2Fx`,
    );
  });

  it("getBranch returns null on 404", async () => {
    const { c } = client({
      status: 404,
      body: { message: "404 Branch Not Found" },
    });
    expect(await c.getBranch({ project: 1, branch: "gone" })).toBeNull();
  });

  it("createBranch posts branch and ref", async () => {
    const { c, calls } = client({ status: 201, body: { name: "b" } });
    await c.createBranch({ project: 1, branch: "b", ref: "main" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${API}/projects/1/repository/branches`,
      body: { branch: "b", ref: "main" },
    });
  });

  it("createBranch throws 400 Branch already exists as-is", async () => {
    const { c } = client({
      status: 400,
      body: { message: "Branch already exists" },
    });
    const err = await c
      .createBranch({ project: 1, branch: "b", ref: "main" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabApiError);
    expect((err as GitLabApiError).status).toBe(400);
    expect((err as GitLabApiError).message).toBe(
      "GitLab API error 400: Branch already exists",
    );
  });

  it("deleteBranch sends DELETE and accepts 204", async () => {
    const { c, calls } = client({ status: 204 });
    await c.deleteBranch({ project: 1, branch: "feat/x" });
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: `${API}/projects/1/repository/branches/feat%2Fx`,
    });
  });

  it("deleteBranch throws on 404", async () => {
    const { c } = client({
      status: 404,
      body: { message: "404 Branch Not Found" },
    });
    await expect(
      c.deleteBranch({ project: 1, branch: "gone" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("listTree", () => {
  it("follows keyset Link headers and keeps only blobs", async () => {
    const next = `${API}/projects/1/repository/tree?id=1&page_token=abc&pagination=keyset&per_page=100&recursive=true&ref=main`;
    const { c, calls } = client(
      {
        body: [
          { path: "src", type: "tree" },
          { path: "src/a.ts", type: "blob" },
        ],
        headers: { link: `<${next}>; rel="next", <${API}/first>; rel="first"` },
      },
      {
        body: [
          { path: "src/b.ts", type: "blob" },
          { path: "sub", type: "commit" },
        ],
      },
    );
    expect(await c.listTree({ project: 1, ref: "main" })).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(calls[0]?.url).toBe(
      `${API}/projects/1/repository/tree?ref=main&recursive=true&per_page=100&pagination=keyset`,
    );
    expect(calls[1]?.url).toBe(next);
  });

  it("follows X-Next-Page when there is no Link header", async () => {
    const { c, calls } = client(
      { body: [{ path: "a", type: "blob" }], headers: { "x-next-page": "2" } },
      { body: [{ path: "b", type: "blob" }], headers: { "x-next-page": "" } },
    );
    expect(await c.listTree({ project: 1, ref: "main" })).toEqual(["a", "b"]);
    expect(calls[1]?.url).toContain("page=2");
  });

  it("refuses a Link that leaves the API root, so the token stays home", async () => {
    const { c, calls } = client({
      body: [],
      headers: { link: '<https://evil.test/api/v4/steal>; rel="next"' },
    });
    await expect(c.listTree({ project: 1, ref: "main" })).rejects.toThrow(
      /outside the API root/,
    );
    expect(calls).toHaveLength(1);
  });

  it("stops when a page repeats", async () => {
    const same = `${API}/projects/1/repository/tree?page_token=x`;
    const { c } = client(
      { body: [], headers: { link: `<${same}>; rel="next"` } },
      { body: [], headers: { link: `<${same}>; rel="next"` } },
    );
    await expect(c.listTree({ project: 1, ref: "main" })).rejects.toThrow(
      /repeated a page/,
    );
  });
});

describe("commitFiles", () => {
  it("posts actions in GitLab's shape and returns the sha", async () => {
    const { c, calls } = client({ status: 201, body: { id: "newsha" } });
    const result = await c.commitFiles({
      project: 1,
      branch: "oxagen/x",
      message: "Update rules",
      actions: [
        { action: "create", filePath: "a.md", content: "A" },
        { action: "update", filePath: "b.md", content: "B" },
        { action: "delete", filePath: "c.md" },
      ],
    });
    expect(result).toEqual({ sha: "newsha" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${API}/projects/1/repository/commits`,
      body: {
        branch: "oxagen/x",
        commit_message: "Update rules",
        actions: [
          { action: "create", file_path: "a.md", content: "A" },
          { action: "update", file_path: "b.md", content: "B" },
          { action: "delete", file_path: "c.md" },
        ],
      },
    });
  });
});

describe("compare", () => {
  it("compares from the merge base and maps diffs", async () => {
    const { c, calls } = client({
      body: {
        diffs: [
          {
            old_path: "a",
            new_path: "b",
            renamed_file: true,
            deleted_file: false,
            new_file: false,
          },
        ],
      },
    });
    expect(await c.compare({ project: 1, from: "main", to: "feat" })).toEqual([
      {
        oldPath: "a",
        newPath: "b",
        renamed: true,
        deleted: false,
        added: false,
      },
    ]);
    expect(calls[0]?.url).toBe(
      `${API}/projects/1/repository/compare?from=main&to=feat&straight=false`,
    );
  });

  it("treats a missing diffs list as no changes", async () => {
    const { c } = client({ body: {} });
    expect(await c.compare({ project: 1, from: "a", to: "b" })).toEqual([]);
  });
});

describe("merge requests", () => {
  it("createMergeRequest joins labels and maps the answer", async () => {
    const { c, calls } = client({ status: 201, body: MR });
    const mr = await c.createMergeRequest({
      project: 42,
      sourceBranch: "oxagen/steer",
      targetBranch: "main",
      title: "Update steering",
      description: "body",
      labels: ["oxagen", "steering"],
      removeSourceBranch: true,
    });
    expect(mr).toEqual(MAPPED_MR);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${API}/projects/42/merge_requests`,
      body: {
        source_branch: "oxagen/steer",
        target_branch: "main",
        title: "Update steering",
        description: "body",
        labels: "oxagen,steering",
        remove_source_branch: true,
      },
    });
  });

  it("createMergeRequest omits empty labels and unset flags", async () => {
    const { c, calls } = client({
      status: 201,
      body: { ...MR, description: null, sha: undefined },
    });
    const mr = await c.createMergeRequest({
      project: 42,
      sourceBranch: "s",
      targetBranch: "t",
      title: "x",
      description: "",
      labels: [],
    });
    expect(calls[0]?.body).toEqual({
      source_branch: "s",
      target_branch: "t",
      title: "x",
      description: "",
    });
    expect(mr.description).toBe("");
    expect(mr.sha).toBeNull();
  });

  it("updateMergeRequest sends only the given fields", async () => {
    const { c, calls } = client(
      { body: { ...MR, state: "closed" } },
      { body: MR },
    );
    const mr = await c.updateMergeRequest({
      project: 42,
      iid: 7,
      stateEvent: "close",
    });
    expect(mr.state).toBe("closed");
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: `${API}/projects/42/merge_requests/7`,
      body: { state_event: "close" },
    });
    await c.updateMergeRequest({
      project: 42,
      iid: 7,
      title: "t",
      description: "d",
    });
    expect(calls[1]?.body).toEqual({ title: "t", description: "d" });
  });

  it("updateMergeRequest refuses a bad iid", async () => {
    const { c } = client();
    await expect(
      c.updateMergeRequest({ project: 42, iid: -1 }),
    ).rejects.toThrow(TypeError);
  });

  it("listMergeRequests filters by branches and state and walks pages", async () => {
    const { c, calls } = client(
      { body: [MR], headers: { "x-next-page": "2" } },
      { body: [{ ...MR, iid: 8 }] },
    );
    const list = await c.listMergeRequests({
      project: 42,
      sourceBranch: "oxagen/steer",
      targetBranch: "main",
      state: "opened",
    });
    expect(list.map((m) => m.iid)).toEqual([7, 8]);
    expect(calls[0]?.url).toBe(
      `${API}/projects/42/merge_requests?source_branch=oxagen%2Fsteer&target_branch=main&state=opened&per_page=100`,
    );
    expect(calls[1]?.url).toContain("page=2");
  });

  it("getMergeRequest reads one by iid", async () => {
    const { c, calls } = client({
      body: {
        ...MR,
        state: "merged",
        merge_commit_sha: "m1",
        squash_commit_sha: "s1",
        merged_at: "2026-09-02T00:00:00Z",
      },
    });
    const mr = await c.getMergeRequest({ project: 42, iid: 7 });
    expect(mr).toMatchObject({
      state: "merged",
      mergeCommitSha: "m1",
      squashCommitSha: "s1",
      mergedAt: "2026-09-02T00:00:00Z",
    });
    expect(calls[0]?.url).toBe(`${API}/projects/42/merge_requests/7`);
  });

  it("getMergeRequest carries the draft flag and GitLab's updated_at", async () => {
    const { c } = client({
      body: { ...MR, draft: true, updated_at: "2026-09-25T10:00:00Z" },
    });
    expect(await c.getMergeRequest({ project: 42, iid: 7 })).toMatchObject({
      draft: true,
      updatedAt: "2026-09-25T10:00:00Z",
    });
    const older = client({ body: { ...MR, work_in_progress: false } });
    const mr = await older.c.getMergeRequest({ project: 42, iid: 7 });
    expect(mr.draft).toBe(false);
    expect(mr).not.toHaveProperty("updatedAt");
  });

  it("mergeMergeRequest pins the sha", async () => {
    const { c, calls } = client({ body: { ...MR, state: "merged" } });
    await c.mergeMergeRequest({
      project: 42,
      iid: 7,
      sha: "abc123",
      squash: true,
      squashCommitMessage: "Squashed",
      shouldRemoveSourceBranch: true,
    });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: `${API}/projects/42/merge_requests/7/merge`,
      body: {
        sha: "abc123",
        squash: true,
        squash_commit_message: "Squashed",
        should_remove_source_branch: true,
      },
    });
  });

  it("mergeMergeRequest surfaces a 409 when the head moved", async () => {
    const { c } = client({
      status: 409,
      body: { message: "SHA does not match HEAD of source branch: def" },
    });
    await expect(
      c.mergeMergeRequest({ project: 42, iid: 7, sha: "abc", squash: false }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("setCommitStatus", () => {
  it("posts the status and maps the answer", async () => {
    const { c, calls } = client({
      status: 201,
      body: { id: 99, target_url: "https://oxagen.test/run/1" },
    });
    const result = await c.setCommitStatus({
      project: 42,
      sha: "abc",
      state: "success",
      name: "oxagen/mandate",
      description: "Within mandate",
      targetUrl: "https://oxagen.test/run/1",
    });
    expect(result).toEqual({ id: 99, targetUrl: "https://oxagen.test/run/1" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${API}/projects/42/statuses/abc`,
      body: {
        state: "success",
        name: "oxagen/mandate",
        description: "Within mandate",
        target_url: "https://oxagen.test/run/1",
      },
    });
  });

  it("omits optional fields and maps a missing target_url to null", async () => {
    const { c, calls } = client({ status: 201, body: { id: 1 } });
    const result = await c.setCommitStatus({
      project: 42,
      sha: "abc",
      state: "pending",
      name: "n",
    });
    expect(calls[0]?.body).toEqual({ state: "pending", name: "n" });
    expect(result.targetUrl).toBeNull();
  });
});

describe("project hooks", () => {
  it("createProjectHook posts the hook with SSL verification on by default", async () => {
    const { c, calls } = client({
      status: 201,
      body: { id: 3, url: "https://oxagen.test/hook" },
    });
    expect(
      await c.createProjectHook({
        project: 42,
        url: "https://oxagen.test/hook",
        token: "hook-secret",
        mergeRequestsEvents: true,
        pushEvents: false,
      }),
    ).toEqual({ id: 3, url: "https://oxagen.test/hook" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${API}/projects/42/hooks`,
      body: {
        url: "https://oxagen.test/hook",
        token: "hook-secret",
        merge_requests_events: true,
        push_events: false,
        enable_ssl_verification: true,
      },
    });
  });

  it("createProjectHook passes an explicit SSL setting", async () => {
    const { c, calls } = client({ status: 201, body: { id: 3, url: "u" } });
    await c.createProjectHook({
      project: 42,
      url: "u",
      token: "t",
      mergeRequestsEvents: false,
      pushEvents: true,
      enableSslVerification: false,
    });
    expect(calls[0]?.body).toMatchObject({ enable_ssl_verification: false });
  });

  it("createProjectHook keeps the webhook secret out of the error", async () => {
    const { c } = client({
      status: 422,
      body: { message: { token: ["hook-secret is invalid"] } },
    });
    const err = (await c
      .createProjectHook({
        project: 42,
        url: "u",
        token: "hook-secret",
        mergeRequestsEvents: true,
        pushEvents: false,
      })
      .catch((e: unknown) => e)) as GitLabApiError;
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(err.message).not.toContain("hook-secret");
    expect(err.message).toBe(
      "GitLab API error 422: token [redacted] is invalid",
    );
  });

  it("deleteProjectHook sends DELETE and throws on 404", async () => {
    const { c, calls } = client(
      { status: 204 },
      { status: 404, body: { message: "404 Not found" } },
    );
    await c.deleteProjectHook({ project: 42, hookId: 3 });
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: `${API}/projects/42/hooks/3`,
    });
    await expect(
      c.deleteProjectHook({ project: 42, hookId: 3 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("errors", () => {
  it("never puts the token in a 401 error", async () => {
    const { c } = client({
      status: 401,
      body: { message: `401 Unauthorized: token ${TOKEN} is invalid` },
    });
    const err = (await c.getCurrentUser().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(err.message).not.toContain(TOKEN);
    expect(String(err.stack)).not.toContain(TOKEN);
    expect(err.message).toBe(
      "GitLab API error 401: 401 Unauthorized: token [redacted] is invalid",
    );
  });

  it("flattens validation maps, lists, and OAuth-style errors", async () => {
    const { c } = client(
      {
        status: 400,
        body: { message: { name: ["has already been taken"], base: ["no"] } },
      },
      { status: 400, body: { message: ["first", "second"] } },
      {
        status: 403,
        body: { error: "insufficient_scope", error_description: "needs api" },
      },
      { status: 403, body: { error: "forbidden" } },
      { status: 500, text: "<html>oops</html>" },
      { status: 500, body: { message: {} } },
    );
    const messages: string[] = [];
    for (let i = 0; i < 6; i++) {
      const err = (await c.getCurrentUser().catch((e: unknown) => e)) as Error;
      messages.push(err.message);
    }
    expect(messages).toEqual([
      "GitLab API error 400: name has already been taken; no",
      "GitLab API error 400: first; second",
      "GitLab API error 403: insufficient_scope: needs api",
      "GitLab API error 403: forbidden",
      "GitLab API error 500: Bad Thing",
      "GitLab API error 500: Bad Thing",
    ]);
  });

  it("truncates a long message", async () => {
    const { c } = client({ status: 400, body: { message: "x".repeat(900) } });
    const err = (await c.getCurrentUser().catch((e: unknown) => e)) as Error;
    expect(err.message.length).toBeLessThan(560);
    expect(err.message.endsWith("...")).toBe(true);
  });
});

describe("retries", () => {
  it("waits Retry-After seconds on 429 and then succeeds", async () => {
    const { c, calls, sleep } = client(
      {
        status: 429,
        body: { message: "Retry later" },
        headers: { "retry-after": "3" },
      },
      { body: { id: 1, username: "u" } },
    );
    expect((await c.getCurrentUser()).id).toBe(1);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(calls).toHaveLength(2);
  });

  it("backs off exponentially on 502/503/504 without Retry-After", async () => {
    const { c, sleep } = client(
      { status: 502, text: "bad gateway" },
      { status: 503, text: "" },
      { body: { id: 1, username: "u" } },
    );
    const f = fakeFetch(
      { status: 504, text: "" },
      { body: { id: 1, username: "u" } },
    );
    await c.getCurrentUser();
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    const sleep2 = vi.fn(async () => {});
    await createGitLabClient({
      token: TOKEN,
      baseUrl: BASE,
      fetch: f.fetch,
      sleep: sleep2,
    }).getCurrentUser();
    expect(sleep2).toHaveBeenCalledWith(1000);
  });

  it("reads an HTTP-date Retry-After", async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const { c, sleep } = client(
      { status: 429, headers: { "retry-after": at } },
      { body: { id: 1, username: "u" } },
    );
    await c.getCurrentUser();
    const waited = (sleep.mock.calls[0] as unknown as [number])[0];
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(5000);
  });

  it("falls back to backoff when Retry-After is unreadable", async () => {
    const { c, sleep } = client(
      { status: 429, headers: { "retry-after": "soon" } },
      { body: { id: 1, username: "u" } },
    );
    await c.getCurrentUser();
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("gives up after maxRetries and throws the last status", async () => {
    const { c, calls, sleep } = client(
      { status: 429 },
      { status: 429 },
      { status: 429, body: { message: "Too many" } },
    );
    await expect(c.getCurrentUser()).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("honours maxRetries: 0", async () => {
    const f = fakeFetch({ status: 503 });
    const c = createGitLabClient({
      token: TOKEN,
      baseUrl: BASE,
      fetch: f.fetch,
      maxRetries: 0,
    });
    await expect(c.getCurrentUser()).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(1);
  });

  it("throws instead of waiting longer than a minute", async () => {
    const { c, sleep } = client({
      status: 429,
      headers: { "retry-after": "3600" },
    });
    await expect(c.getCurrentUser()).rejects.toMatchObject({ status: 429 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry other statuses", async () => {
    const { c, calls } = client({ status: 500, body: { message: "boom" } });
    await expect(c.getCurrentUser()).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });

  it("uses a real timer when no sleep is injected", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch(
        { status: 503, headers: { "retry-after": "1" } },
        { body: { id: 1, username: "u" } },
      );
      const c = createGitLabClient({
        token: TOKEN,
        baseUrl: BASE,
        fetch: f.fetch,
      });
      const pending = c.getCurrentUser();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await pending).id).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
