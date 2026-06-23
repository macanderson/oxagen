import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  runInTenantScope: vi.fn(),
  upsertSourceConnectionMeta: vi.fn().mockResolvedValue(undefined),
  decrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  fetchMock: vi.fn(),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
}));

type HandlerCtx = {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
    sendEvent: (name: string, payload: unknown) => Promise<void>;
  };
};
let capturedHandler: ((ctx: HandlerCtx) => unknown) | null = null;
// Capture the createFunction args at registration time (before clearAllMocks).
let capturedCreateFunctionArgs: unknown[] | null = null;

mocks.createFunction.mockImplementation(
  (opts: unknown, trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    capturedCreateFunctionArgs = [opts, trigger, handler];
    return {};
  },
);

vi.mock("../../inngest", () => ({
  inngest: { createFunction: mocks.createFunction },
}));

// sql tagged template literal that returns a plain object (good enough for mocked tx.execute)
const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
Object.assign(sqlTag, { mapWith: () => sqlTag, raw: () => sqlTag });

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
}));

vi.mock("drizzle-orm", () => ({
  sql: sqlTag,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@oxagen/ingestion/mutations", () => ({
  upsertSourceConnectionMeta: mocks.upsertSourceConnectionMeta,
}));

vi.mock("@oxagen/crypto", () => ({
  createIngestionCryptoAdapter: mocks.createIngestionCryptoAdapter,
  decrypt: mocks.decrypt,
}));

vi.mock("../../logger", () => ({
  logger: { info: mocks.loggerInfo, debug: mocks.loggerDebug, error: vi.fn(), warn: vi.fn() },
}));

// Capture global.fetch before module import.
vi.stubGlobal("fetch", mocks.fetchMock);

await import("../ingestion.github-initial-sync");

// ── Fixture data ──────────────────────────────────────────────────────────────

const BASE_EVENT = {
  connectionId: "conn-gh-1",
  orgId: "org-gh-1",
  workspaceId: "ws-gh-1",
  owner: "acme",
  repo: "api",
  syncDepthDays: 90,
};

const REPO_META = {
  id: 42,
  name: "api",
  full_name: "acme/api",
  description: "The API",
  html_url: "https://github.com/acme/api",
  default_branch: "trunk", // deliberately not "main" — verifies branch resolution
  owner: { login: "acme" },
  language: "TypeScript",
  stargazers_count: 7,
};

const PULLS = [
  { number: 1, title: "Add auth", html_url: "https://github.com/acme/api/pull/1", user: { login: "a" }, labels: [], state: "open" },
  { number: 2, title: "Fix billing", html_url: "https://github.com/acme/api/pull/2", user: { login: "b" }, labels: [], state: "closed" },
];

// GitHub's issues API returns PRs too (they carry a `pull_request` key) — those
// must be filtered out so they aren't double-ingested.
const ISSUES_RAW = [
  { number: 10, title: "Bug report", html_url: "https://github.com/acme/api/issues/10", user: { login: "c" }, labels: [] },
  { number: 2, title: "Fix billing", html_url: "https://github.com/acme/api/pull/2", user: { login: "b" }, labels: [], pull_request: { url: "x" } },
];

const RELEASES = [
  { id: 99, name: "v1.0.0", tag_name: "v1.0.0", html_url: "https://github.com/acme/api/releases/v1.0.0", author: { login: "a" } },
];

const COMMITS = [
  { sha: "deadbeef", html_url: "https://github.com/acme/api/commit/deadbeef", commit: { message: "init", author: { name: "a", email: "a@x.com", date: "2026-01-01" } } },
];

const TREE_RESPONSE = {
  sha: "abc123",
  url: "https://api.github.com/repos/acme/api/git/trees/trunk",
  truncated: false,
  tree: [
    { path: "src/auth.ts", mode: "100644", type: "blob", sha: "sha-auth", size: 1000, url: "" },
    { path: "src/billing.ts", mode: "100644", type: "blob", sha: "sha-billing", size: 2000, url: "" },
    { path: "src/utils.py", mode: "100644", type: "blob", sha: "sha-utils", size: 500, url: "" },
    // Excluded paths:
    { path: "node_modules/lodash/index.js", mode: "100644", type: "blob", sha: "sha-lodash", size: 100, url: "" },
    { path: "dist/bundle.js", mode: "100644", type: "blob", sha: "sha-dist", size: 9999, url: "" },
    // Non-matching extension:
    { path: "README.md", mode: "100644", type: "blob", sha: "sha-readme", size: 200, url: "" },
    // Zero size:
    { path: "src/empty.ts", mode: "100644", type: "blob", sha: "sha-empty", size: 0, url: "" },
    // Tree (not blob):
    { path: "src", mode: "040000", type: "tree", sha: "sha-tree", url: "" },
  ],
};

const ACCESS_TOKEN_ENC = { keyId: "key-1", ciphertext: Buffer.from("token123").toString("base64") };

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Route the GitHub REST calls the sync makes to their fixture responses. */
function routedFetch(treeOverride?: unknown) {
  return (url: string) => {
    if (url.includes("/git/trees/")) return ok(treeOverride ?? TREE_RESPONSE);
    if (url.includes("/pulls")) return ok(PULLS);
    if (url.includes("/issues")) return ok(ISSUES_RAW);
    if (url.includes("/releases")) return ok(RELEASES);
    if (url.includes("/commits")) return ok(COMMITS);
    return ok(REPO_META); // GET /repos/{owner}/{repo}
  };
}

function setupDefaultMocks(): void {
  mocks.createIngestionCryptoAdapter.mockReturnValue({ keyId: "key-1", adapter: {} });
  mocks.decrypt.mockResolvedValue(Buffer.from("ghp_test_token"));

  mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ execute: vi.fn().mockResolvedValue([{ access_token_enc: ACCESS_TOKEN_ENC }]) }),
  );

  mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());

  mocks.fetchMock.mockImplementation(routedFetch());
}

function makeStep(overrides: Partial<HandlerCtx["step"]> = {}): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Flatten all events passed to step.sendEvent across calls. */
function allEventsFrom(sendEvent: ReturnType<typeof vi.fn>): Array<{ name: string; data: Record<string, unknown> }> {
  return sendEvent.mock.calls.flatMap((c) => {
    const payload = c[1];
    return (Array.isArray(payload) ? payload : [payload]) as Array<{ name: string; data: Record<string, unknown> }>;
  });
}

function entitiesOfType(sendEvent: ReturnType<typeof vi.fn>, sourceRecordType: string) {
  return allEventsFrom(sendEvent).filter(
    (e) => e.name === "ingestion/entity.received" && e.data?.["sourceRecordType"] === sourceRecordType,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ingestion.github-initial-sync Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("registers a createFunction with correct id and event trigger", () => {
    expect(capturedCreateFunctionArgs).not.toBeNull();
    const [opts, trigger] = capturedCreateFunctionArgs as [Record<string, unknown>, Record<string, unknown>];
    expect(opts).toMatchObject({
      id: "ingestion-github-initial-sync",
      retries: 3,
      concurrency: expect.objectContaining({ limit: 2, key: "event.data.orgId" }),
    });
    expect(trigger).toMatchObject({ event: "ingestion/github.initial-sync" });
  });

  it("decrypts the access token from oauth_accounts", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(mocks.decrypt).toHaveBeenCalledTimes(1);
  });

  it("throws when owner/repo are missing", async () => {
    const step = makeStep();
    await expect(
      capturedHandler!({ event: { data: { ...BASE_EVENT, owner: "", repo: "" } }, step }),
    ).rejects.toThrow(/owner and repo are required/);
  });

  it("resolves the repo's real default branch and uses it for the tree fetch", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    // REPO_META.default_branch === "trunk" — the tree must be fetched on trunk.
    expect(mocks.fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.github.com/repos/acme/api/git/trees/trunk"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer") }),
      }),
    );
  });

  it("emits a repository entity.received", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const repos = entitiesOfType(sendEvent, "repository");
    expect(repos).toHaveLength(1);
    expect(repos[0]!.data).toMatchObject({
      connectorType: "github",
      connectionId: "conn-gh-1",
      orgId: "org-gh-1",
      workspaceId: "ws-gh-1",
    });
    expect((repos[0]!.data["payload"] as Record<string, unknown>)["full_name"]).toBe("acme/api");
  });

  it("backfills pull_request, issue, release, and commit entities", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(entitiesOfType(sendEvent, "pull_request")).toHaveLength(2);
    // ISSUES_RAW has 2 entries but one is a PR (has pull_request key) → filtered out.
    expect(entitiesOfType(sendEvent, "issue")).toHaveLength(1);
    expect(entitiesOfType(sendEvent, "release")).toHaveLength(1);
    const commits = entitiesOfType(sendEvent, "commit");
    expect(commits).toHaveLength(1);
    // git_branch is injected so trigger conditions can match on it.
    expect((commits[0]!.data["payload"] as Record<string, unknown>)["git_branch"]).toBe("trunk");
  });

  it("dispatches one ingestion/github.parse-file per accepted source file (3)", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const parseFiles = allEventsFrom(sendEvent).filter((e) => e.name === "ingestion/github.parse-file");
    expect(parseFiles).toHaveLength(3);
    for (const ev of parseFiles) {
      expect(ev.data).toMatchObject({
        connectionId: "conn-gh-1",
        owner: "acme",
        repo: "api",
        sha: expect.any(String),
        path: expect.any(String),
      });
    }
  });

  it("calls upsertSourceConnectionMeta inside runInTenantScope", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(mocks.upsertSourceConnectionMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-gh-1",
        workspaceId: "ws-gh-1",
        connectorType: "github",
        healthStatus: "healthy",
      }),
      "org-gh-1",
    );
  });

  it("calls withSystemDb for token fetch + status update (2)", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });

  it("returns connectionId, owner, repo, fileCount, and entityCount", async () => {
    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(result).toMatchObject({
      connectionId: "conn-gh-1",
      owner: "acme",
      repo: "api",
      fileCount: 3,
      // 1 repo + 2 PRs + 1 issue + 1 release + 1 commit
      entityCount: 6,
    });
  });

  it("throws when the GitHub tree API returns non-OK status", async () => {
    mocks.fetchMock.mockImplementation((url: string) => {
      if (url.includes("/git/trees/")) return Promise.resolve({ ok: false, status: 404 });
      return routedFetch()(url);
    });
    const step = makeStep();
    await expect(capturedHandler!({ event: { data: BASE_EVENT }, step })).rejects.toThrow(
      /GitHub tree API returned 404/,
    );
  });

  it("throws when no oauth token is found", async () => {
    mocks.withSystemDb.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({ execute: vi.fn().mockResolvedValue([]) }),
    );
    const step = makeStep();
    await expect(capturedHandler!({ event: { data: BASE_EVENT }, step })).rejects.toThrow(
      /no oauth token/,
    );
  });

  it("throws NonRetriableError when owner is empty (OXA-1806 guard)", async () => {
    // Empty owner → GitHub URL would be /repos///git/trees/main → 404.
    // The function must abort immediately with NonRetriableError rather than
    // fetching a doomed URL and burning all 3 retries.
    const step = makeStep();
    await expect(
      capturedHandler!({
        event: { data: { ...BASE_EVENT, owner: "" } },
        step,
      }),
    ).rejects.toMatchObject({ name: "NonRetriableError" });

    // No GitHub fetch should have been attempted
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it("throws NonRetriableError when repo is empty (OXA-1806 guard)", async () => {
    const step = makeStep();
    await expect(
      capturedHandler!({
        event: { data: { ...BASE_EVENT, repo: "" } },
        step,
      }),
    ).rejects.toMatchObject({ name: "NonRetriableError" });

    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches files in batches when tree has > 50 files", async () => {
    // Build a large tree (75 .ts files, all valid).
    const largeTrees = Array.from({ length: 75 }, (_, i) => ({
      path: `src/file${i}.ts`,
      mode: "100644",
      type: "blob",
      sha: `sha-${i}`,
      size: 1000,
      url: "",
    }));
    mocks.fetchMock.mockImplementation(routedFetch({ ...TREE_RESPONSE, tree: largeTrees }));

    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    // Count parse-file batches specifically (other sendEvent calls emit entities).
    const parseFileBatches = sendEvent.mock.calls.filter((c) => {
      const payload = c[1];
      return Array.isArray(payload) && payload[0]?.name === "ingestion/github.parse-file";
    });
    expect(parseFileBatches).toHaveLength(2); // 75 files / 50 = 2 batches
  });
});
