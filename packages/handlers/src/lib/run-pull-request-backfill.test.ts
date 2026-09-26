import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // What each withTenantDb call answers, in call order.
  answers: [] as unknown[][],
  statements: [] as { sql: string; params: unknown[] }[],
  // The tenant scope each withTenantDb call ran in, in call order.
  scopes: [] as ({ orgId: string; workspaceId: string } | null)[],
  getPullRequest: vi.fn(),
  getMergeRequest: vi.fn(),
  resolveGitHubToken: vi.fn(),
  findWorkspaceGitLabConnection: vi.fn(),
  resolveGitLabCredential: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { getScope } = await import("@oxagen/tenancy");
  const db = drizzle.mock({ schema: actual.schema });
  return {
    ...actual,
    withTenantDb: (fn: (tx: typeof db) => { toSQL(): unknown }) => {
      const scope = getScope();
      mocks.scopes.push(
        scope ? { orgId: scope.orgId, workspaceId: scope.workspaceId } : null,
      );
      mocks.statements.push(
        fn(db).toSQL() as { sql: string; params: unknown[] },
      );
      return Promise.resolve(mocks.answers.shift() ?? []);
    },
  };
});
vi.mock("@oxagen/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/github")>();
  return {
    ...actual,
    createGitHubClient: () => ({ getPullRequest: mocks.getPullRequest }),
  };
});
vi.mock("@oxagen/github/workspace-token", () => ({
  resolveGitHubToken: mocks.resolveGitHubToken,
}));
vi.mock("@oxagen/gitlab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/gitlab")>();
  return {
    ...actual,
    createGitLabClient: () => ({ getMergeRequest: mocks.getMergeRequest }),
  };
});
vi.mock("../repository.gitlab-connection", () => ({
  findWorkspaceGitLabConnection: mocks.findWorkspaceGitLabConnection,
}));
vi.mock("./gitlab-credential", () => ({
  resolveGitLabCredential: mocks.resolveGitLabCredential,
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GitHubApiError } from "@oxagen/github";
import { GitLabApiError } from "@oxagen/gitlab";
import {
  backfillRunPullRequest,
  githubConnectionOf,
  type GithubConnectionRow,
  type PullRequestBackfillDeps,
  pullRequestBackfillDeps,
  runPullRequestBackfill,
} from "./run-pull-request-backfill";

/** A legacy source that names its owner, as the sources wizard wrote it. */
const CONNECTION: GithubConnectionRow = {
  id: "conn-1",
  deliveryConfig: { owner: "Acme", repo: "api", installationId: "777" },
  oauthAccountId: null,
};

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const REQUEST = {
  ...SCOPE,
  rootSessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  url: "https://github.com/Acme/API/pull/42",
};
const GH_KEY = {
  provider: "github",
  repository: "acme/api",
  number: 42,
} as const;
const GL_KEY = {
  provider: "gitlab",
  repository: "acme/platform/api",
  number: 9,
} as const;

beforeEach(() => {
  mocks.answers = [];
  mocks.statements = [];
  mocks.scopes = [];
  for (const fn of [
    mocks.getPullRequest,
    mocks.getMergeRequest,
    mocks.resolveGitHubToken,
    mocks.findWorkspaceGitLabConnection,
    mocks.resolveGitLabCredential,
  ])
    fn.mockReset();
});

function fakeDeps(over: Partial<PullRequestBackfillDeps> = {}) {
  const deps: PullRequestBackfillDeps = {
    rootSessionId: vi.fn(() => Promise.resolve("session-id")),
    insertRow: vi.fn(() => Promise.resolve()),
    readForge: vi.fn(() =>
      Promise.resolve({
        state: "merged" as const,
        draft: false,
        sourceUpdatedAt: new Date("2026-09-25T10:00:00Z"),
      }),
    ),
    apply: vi.fn(() => Promise.resolve(1)),
    now: () => new Date("2026-09-25T10:00:05Z"),
    ...over,
  };
  return deps;
}

describe("backfillRunPullRequest", () => {
  it("stores the row, reads the forge once, and writes its state", async () => {
    const deps = fakeDeps();
    expect(await backfillRunPullRequest(deps, REQUEST)).toEqual({
      outcome: "recorded",
      rows: 1,
    });
    expect(deps.rootSessionId).toHaveBeenCalledWith(
      SCOPE,
      REQUEST.rootSessionUuid,
    );
    expect(deps.insertRow).toHaveBeenCalledWith(SCOPE, {
      sessionId: "session-id",
      url: REQUEST.url,
      key: GH_KEY,
    });
    expect(deps.readForge).toHaveBeenCalledTimes(1);
    expect(deps.apply).toHaveBeenCalledWith(
      SCOPE,
      GH_KEY,
      expect.objectContaining({ state: "merged" }),
      new Date("2026-09-25T10:00:05Z"),
    );
  });

  it.each(["no_connection", "unreadable"] as const)(
    "keeps the row with no state when the read answers %s (negative)",
    async (read) => {
      const deps = fakeDeps({ readForge: () => Promise.resolve(read) });
      expect(await backfillRunPullRequest(deps, REQUEST)).toEqual({
        outcome: read,
        rows: 0,
      });
      expect(deps.insertRow).toHaveBeenCalledTimes(1);
      expect(deps.apply).not.toHaveBeenCalled();
    },
  );

  it("stores nothing for a link on a forge Oxagen does not connect (negative)", async () => {
    const deps = fakeDeps();
    expect(
      await backfillRunPullRequest(deps, {
        ...REQUEST,
        url: "https://git.example.com/acme/api/pull/42",
      }),
    ).toEqual({ outcome: "not_a_forge_link", rows: 0 });
    expect(deps.rootSessionId).not.toHaveBeenCalled();
  });

  it("stores nothing when the root session is not in this workspace (negative)", async () => {
    const deps = fakeDeps({ rootSessionId: () => Promise.resolve(null) });
    expect(await backfillRunPullRequest(deps, REQUEST)).toEqual({
      outcome: "no_session",
      rows: 0,
    });
    expect(deps.insertRow).not.toHaveBeenCalled();
  });
});

describe("pullRequestBackfillDeps", () => {
  it("finds the root session in the event's tenant only", async () => {
    mocks.answers = [[{ id: "sid" }]];
    expect(
      await pullRequestBackfillDeps.rootSessionId(
        SCOPE,
        REQUEST.rootSessionUuid,
      ),
    ).toBe("sid");
    const [read] = mocks.statements;
    expect(read?.sql).toContain('"parent_session_uuid" is null');
    expect(read?.params).toEqual(
      expect.arrayContaining([
        SCOPE.orgId,
        SCOPE.workspaceId,
        REQUEST.rootSessionUuid,
      ]),
    );
  });

  it("reads a GitHub pull request with the workspace connection for its owner", async () => {
    mocks.answers = [[CONNECTION]];
    mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
    mocks.getPullRequest.mockResolvedValue({
      state: "open",
      draft: true,
      merged: false,
      updatedAt: "2026-09-25T10:00:00Z",
    });
    expect(await pullRequestBackfillDeps.readForge(SCOPE, GH_KEY)).toEqual({
      state: "open",
      draft: true,
      sourceUpdatedAt: new Date("2026-09-25T10:00:00Z"),
    });
    expect(mocks.resolveGitHubToken).toHaveBeenCalledWith({
      ...SCOPE,
      connectionId: "conn-1",
    });
    expect(mocks.getPullRequest).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      number: 42,
    });
    expect(mocks.statements[0]?.params).toEqual(
      expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId, "github"]),
    );
  });

  // Regression: the sources `workspace.create` and `bind_main_repository`
  // make carry only `{ installationId }`. A read that required a stored
  // owner found none of them, so no modern workspace ever got a state.
  it("reads through a source that records only its installation", async () => {
    mocks.answers = [
      [
        {
          id: "conn-modern",
          deliveryConfig: { installationId: 12345 },
          oauthAccountId: null,
        },
      ],
    ];
    mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
    mocks.getPullRequest.mockResolvedValue({ state: "closed", merged: true });
    expect(await pullRequestBackfillDeps.readForge(SCOPE, GH_KEY)).toEqual(
      expect.objectContaining({ state: "merged" }),
    );
    expect(mocks.resolveGitHubToken).toHaveBeenCalledWith({
      ...SCOPE,
      connectionId: "conn-modern",
    });
  });

  it("answers no_connection with no GitHub connection for the owner (negative)", async () => {
    mocks.answers = [[]];
    expect(await pullRequestBackfillDeps.readForge(SCOPE, GH_KEY)).toBe(
      "no_connection",
    );
    expect(mocks.resolveGitHubToken).not.toHaveBeenCalled();
  });

  it.each([403, 404, 410])(
    "answers unreadable when GitHub answers %i (negative)",
    async (status) => {
      mocks.answers = [[CONNECTION]];
      mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
      mocks.getPullRequest.mockRejectedValue(new GitHubApiError(status, "no"));
      expect(await pullRequestBackfillDeps.readForge(SCOPE, GH_KEY)).toBe(
        "unreadable",
      );
    },
  );

  it("throws on any other GitHub failure, so the function retries (negative)", async () => {
    mocks.answers = [[CONNECTION]];
    mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
    mocks.getPullRequest.mockRejectedValue(new GitHubApiError(502, "bad"));
    await expect(
      pullRequestBackfillDeps.readForge(SCOPE, GH_KEY),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("reads a GitLab merge request through the workspace's connection for the project", async () => {
    mocks.findWorkspaceGitLabConnection.mockResolvedValue({
      id: "gl-conn",
      status: "connected",
      config: { projectId: "4242", projectPath: "acme/platform/api" },
    });
    mocks.resolveGitLabCredential.mockResolvedValue({ token: "glpat" });
    mocks.getMergeRequest.mockResolvedValue({
      state: "merged",
      updatedAt: "2026-09-25T10:00:00Z",
    });
    expect(await pullRequestBackfillDeps.readForge(SCOPE, GL_KEY)).toEqual({
      state: "merged",
      draft: false,
      sourceUpdatedAt: new Date("2026-09-25T10:00:00Z"),
    });
    expect(mocks.findWorkspaceGitLabConnection).toHaveBeenCalledWith(SCOPE, {
      path: "acme/platform/api",
    });
    expect(mocks.getMergeRequest).toHaveBeenCalledWith({
      project: "4242",
      iid: 9,
    });
  });

  it("answers no_connection for a GitLab connection that is not live (negative)", async () => {
    mocks.findWorkspaceGitLabConnection.mockResolvedValue({
      id: "gl-conn",
      status: "error",
      config: { projectId: "4242", projectPath: "acme/platform/api" },
    });
    expect(await pullRequestBackfillDeps.readForge(SCOPE, GL_KEY)).toBe(
      "no_connection",
    );
    expect(mocks.resolveGitLabCredential).not.toHaveBeenCalled();
  });

  it("answers unreadable when GitLab answers 404 (negative)", async () => {
    mocks.findWorkspaceGitLabConnection.mockResolvedValue({
      id: "gl-conn",
      status: "connected",
      config: { projectId: "4242", projectPath: "acme/platform/api" },
    });
    mocks.resolveGitLabCredential.mockResolvedValue({ token: "glpat" });
    mocks.getMergeRequest.mockRejectedValue(new GitLabApiError(404, "gone"));
    expect(await pullRequestBackfillDeps.readForge(SCOPE, GL_KEY)).toBe(
      "unreadable",
    );
  });

  it("inserts once per session and URL, and applies newer-wins in the workspace", async () => {
    await pullRequestBackfillDeps.insertRow(SCOPE, {
      sessionId: "0192d4a8-7c1e-7a00-8000-0000000000ff",
      url: REQUEST.url,
      key: GH_KEY,
    });
    mocks.answers = [[{ id: "r1" }]];
    expect(
      await pullRequestBackfillDeps.apply(
        SCOPE,
        GH_KEY,
        {
          state: "closed",
          draft: false,
          sourceUpdatedAt: new Date("2026-09-25T10:00:00Z"),
        },
        new Date(),
      ),
    ).toBe(1);
    const [insert, update] = mocks.statements;
    expect(insert?.sql).toContain(
      'on conflict ("session_id","url") do nothing',
    );
    expect(update?.sql).toContain('"source_updated_at" <= $');
    expect(update?.params).toEqual(
      expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId]),
    );
  });
});

describe("runPullRequestBackfill", () => {
  it("runs every read and write in the event's own tenant scope", async () => {
    mocks.answers = [
      [{ id: "sid" }],
      [],
      [
        {
          id: "conn-modern",
          deliveryConfig: { installationId: 12345 },
          oauthAccountId: null,
        },
      ],
      [{ id: "r1" }],
    ];
    mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
    mocks.getPullRequest.mockResolvedValue({ state: "open", draft: false });
    expect(await runPullRequestBackfill(REQUEST)).toEqual({
      outcome: "recorded",
      rows: 1,
    });
    expect(mocks.scopes).toHaveLength(4);
    for (const scope of mocks.scopes) expect(scope).toEqual(SCOPE);
  });
});

describe("githubConnectionOf", () => {
  const modern: GithubConnectionRow = {
    id: "modern",
    deliveryConfig: { installationId: "12345" },
    oauthAccountId: null,
  };

  it("prefers a source that names the owner over a newer one that names none", () => {
    expect(githubConnectionOf([modern, CONNECTION], "acme")).toBe("conn-1");
  });

  it("falls back to the newest source that names no owner and holds a credential", () => {
    const oauth: GithubConnectionRow = {
      id: "oauth",
      deliveryConfig: {},
      oauthAccountId: "acct",
    };
    expect(githubConnectionOf([modern, oauth], "acme")).toBe("modern");
    expect(githubConnectionOf([oauth], "acme")).toBe("oauth");
  });

  it("never tries a source that names another owner (negative)", () => {
    const other: GithubConnectionRow = {
      id: "other",
      deliveryConfig: { owner: "globex", installationId: "9" },
      oauthAccountId: null,
    };
    expect(githubConnectionOf([other], "acme")).toBeNull();
  });

  it("never tries a source with no credential at all (negative)", () => {
    const bare: GithubConnectionRow = {
      id: "bare",
      deliveryConfig: null,
      oauthAccountId: null,
    };
    expect(githubConnectionOf([bare], "acme")).toBeNull();
    expect(githubConnectionOf([], "acme")).toBeNull();
  });
});
