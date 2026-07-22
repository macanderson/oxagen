import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  runInTenantScope: vi.fn(),
  upsertSourceConnectionMeta: vi.fn().mockResolvedValue(undefined),
  decrypt: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
  fetchMock: vi.fn(),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
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
const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
  strings,
  values,
});
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
  resolveIngestionCryptoAdapterForKeyId:
    mocks.resolveIngestionCryptoAdapterForKeyId,
  decrypt: mocks.decrypt,
}));

vi.mock("../../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    debug: mocks.loggerDebug,
    error: vi.fn(),
    warn: mocks.loggerWarn,
  },
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
  {
    number: 1,
    title: "Add auth",
    html_url: "https://github.com/acme/api/pull/1",
    user: { login: "a" },
    labels: [],
    state: "open",
  },
  {
    number: 2,
    title: "Fix billing",
    html_url: "https://github.com/acme/api/pull/2",
    user: { login: "b" },
    labels: [],
    state: "closed",
  },
];

// GitHub's issues API returns PRs too (they carry a `pull_request` key) — those
// must be filtered out so they aren't double-ingested.
const ISSUES_RAW = [
  {
    number: 10,
    title: "Bug report",
    html_url: "https://github.com/acme/api/issues/10",
    user: { login: "c" },
    labels: [],
  },
  {
    number: 2,
    title: "Fix billing",
    html_url: "https://github.com/acme/api/pull/2",
    user: { login: "b" },
    labels: [],
    pull_request: { url: "x" },
  },
];

const RELEASES = [
  {
    id: 99,
    name: "v1.0.0",
    tag_name: "v1.0.0",
    html_url: "https://github.com/acme/api/releases/v1.0.0",
    author: { login: "a" },
  },
];

const COMMITS = [
  {
    sha: "deadbeef",
    html_url: "https://github.com/acme/api/commit/deadbeef",
    commit: {
      message: "init",
      author: { name: "a", email: "a@x.com", date: "2026-01-01" },
    },
  },
];

const ACCESS_TOKEN_ENC = {
  keyId: "key-1",
  ciphertext: Buffer.from("token123").toString("base64"),
};

function ok(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

/** Route the GitHub REST calls the sync makes to their fixture responses. */
function routedFetch() {
  return (url: string) => {
    if (url.includes("/pulls")) return ok(PULLS);
    if (url.includes("/issues")) return ok(ISSUES_RAW);
    if (url.includes("/releases")) return ok(RELEASES);
    if (url.includes("/commits")) return ok(COMMITS);
    return ok(REPO_META); // GET /repos/{owner}/{repo}
  };
}

/** Generate n synthetic commit records with unique SHAs (prefix-i). */
function genCommits(n: number, prefix: string): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    sha: `${prefix}-${i}`,
    html_url: `https://github.com/acme/api/commit/${prefix}-${i}`,
    commit: {
      message: `msg ${prefix}-${i}`,
      author: { name: "a", email: "a@x.com", date: "2026-01-01" },
    },
  }));
}

/**
 * Fetch mock that serves the commits list endpoint page-by-page from `pages`
 * (1-indexed; missing pages return []) and everything else from routedFetch.
 */
function pagedCommitsFetch(pages: Record<number, unknown[]>) {
  return (url: string) => {
    if (url.includes("/commits")) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return ok(pages[page] ?? []);
    }
    return routedFetch()(url);
  };
}

function setupDefaultMocks(): void {
  mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({
    keyId: "key-1",
    adapter: {},
  });
  mocks.decrypt.mockResolvedValue(Buffer.from("ghp_test_token"));

  mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      execute: vi
        .fn()
        .mockResolvedValue([{ access_token_enc: ACCESS_TOKEN_ENC }]),
    }),
  );

  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );

  mocks.fetchMock.mockImplementation(routedFetch());
}

function makeStep(
  overrides: Partial<HandlerCtx["step"]> = {},
): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Flatten all events passed to step.sendEvent across calls. */
function allEventsFrom(
  sendEvent: ReturnType<typeof vi.fn>,
): Array<{ name: string; data: Record<string, unknown> }> {
  return sendEvent.mock.calls.flatMap((c) => {
    const payload = c[1];
    return (Array.isArray(payload) ? payload : [payload]) as Array<{
      name: string;
      data: Record<string, unknown>;
    }>;
  });
}

function entitiesOfType(
  sendEvent: ReturnType<typeof vi.fn>,
  sourceRecordType: string,
) {
  return allEventsFrom(sendEvent).filter(
    (e) =>
      e.name === "ingestion/entity.received" &&
      e.data?.["sourceRecordType"] === sourceRecordType,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ingestion.github-initial-sync Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers a createFunction with correct id and event trigger", () => {
    expect(capturedCreateFunctionArgs).not.toBeNull();
    const [opts, trigger] = capturedCreateFunctionArgs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opts).toMatchObject({
      id: "ingestion-github-initial-sync",
      retries: 3,
      concurrency: expect.objectContaining({
        limit: 2,
        key: "event.data.orgId",
      }),
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
      capturedHandler!({
        event: { data: { ...BASE_EVENT, owner: "", repo: "" } },
        step,
      }),
    ).rejects.toThrow(/owner and repo are required/);
  });

  it("resolves the repo's real default branch and uses it for commit backfill", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    const commitUrl = mocks.fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("/commits?"));
    expect(commitUrl).toContain("sha=trunk");
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
    expect(
      (repos[0]!.data["payload"] as Record<string, unknown>)["full_name"],
    ).toBe("acme/api");
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
    expect(
      (commits[0]!.data["payload"] as Record<string, unknown>)["git_branch"],
    ).toBe("trunk");
  });

  it("emits only provider entities and never detailed-code work", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(
      allEventsFrom(sendEvent).every(
        (e) => e.name === "ingestion/entity.received",
      ),
    ).toBe(true);
    expect(
      mocks.fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/git/trees/"),
      ),
    ).toBe(false);
  });

  it("calls upsertSourceConnectionMeta inside runInTenantScope", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(mocks.upsertSourceConnectionMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-gh-1",
        workspaceId: "ws-gh-1",
        connectorType: "github",
        entityCountDelta: 6,
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

  it("returns connectionId, owner, repo, and provider entityCount", async () => {
    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({
      connectionId: "conn-gh-1",
      owner: "acme",
      repo: "api",
      // 1 repo + 2 PRs + 1 issue + 1 release + 1 commit
      entityCount: 6,
    });
    expect(result).not.toHaveProperty("fileCount");
  });

  it("throws when no oauth token is found", async () => {
    mocks.withSystemDb.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({ execute: vi.fn().mockResolvedValue([]) }),
    );
    const step = makeStep();
    await expect(
      capturedHandler!({ event: { data: BASE_EVENT }, step }),
    ).rejects.toThrow(/no oauth token/);
  });

  it("throws NonRetriableError when owner is empty (OXA-1806 guard)", async () => {
    // The function must abort immediately with NonRetriableError rather than
    // fetching a doomed provider URL and burning all 3 retries.
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

  // ── Commit-history backfill: syncDepthDays window, pagination, caps ─────────

  /** All commit-list API calls (GET /repos/{o}/{r}/commits?...) made so far. */
  function commitListCalls(): string[] {
    return mocks.fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((url) => url.includes("/commits?"));
  }

  it("computes `since` from syncDepthDays and passes it to the commits list API", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const step = makeStep();
    await capturedHandler!({
      event: { data: { ...BASE_EVENT, syncDepthDays: 30 } },
      step,
    });

    const expectedSince = new Date(
      Date.parse("2026-07-10T12:00:00.000Z") - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const calls = commitListCalls();
    expect(calls).toHaveLength(1); // fixture returns 1 commit → short page → no page 2
    expect(calls[0]).toContain(`since=${encodeURIComponent(expectedSince)}`);
    expect(calls[0]).toContain("per_page=100");
    expect(calls[0]).toContain("page=1");
    expect(calls[0]).toContain("sha=trunk");
  });

  it("defaults syncDepthDays to 90 days when absent or invalid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const expectedSince = encodeURIComponent(
      new Date(
        Date.parse("2026-07-10T12:00:00.000Z") - 90 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    );

    // Absent → 90-day window.
    const eventWithoutDepth: Record<string, unknown> = { ...BASE_EVENT };
    delete eventWithoutDepth["syncDepthDays"];
    await capturedHandler!({
      event: { data: eventWithoutDepth },
      step: makeStep(),
    });
    expect(commitListCalls()[0]).toContain(`since=${expectedSince}`);

    // Invalid (zero) → 90-day window too.
    mocks.fetchMock.mockClear();
    await capturedHandler!({
      event: { data: { ...BASE_EVENT, syncDepthDays: 0 } },
      step: makeStep(),
    });
    expect(commitListCalls()[0]).toContain(`since=${expectedSince}`);
  });

  it("paginates the commit list past the first page, accumulating all pages", async () => {
    // Page 1 is full (100) → fetch page 2; page 2 is short (40) → stop.
    mocks.fetchMock.mockImplementation(
      pagedCommitsFetch({ 1: genCommits(100, "p1"), 2: genCommits(40, "p2") }),
    );

    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const commitEntities = entitiesOfType(sendEvent, "commit");
    expect(commitEntities).toHaveLength(140);
    // Every commit still flows through entity.received with the branch injected.
    expect(
      (commitEntities[0]!.data["payload"] as Record<string, unknown>)[
        "git_branch"
      ],
    ).toBe("trunk");
    expect(commitListCalls()).toHaveLength(2);
    // No runaway: the short page ended pagination, no warning logged.
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("caps the commit backfill at MAX_COMMITS_BACKFILL (500) and logs a warning", async () => {
    // Six full pages available — only five (500 commits) may be fetched.
    const pages: Record<number, unknown[]> = {
      1: genCommits(100, "p1"),
      2: genCommits(100, "p2"),
      3: genCommits(100, "p3"),
      4: genCommits(100, "p4"),
      5: genCommits(100, "p5"),
      6: genCommits(100, "p6"),
    };
    mocks.fetchMock.mockImplementation(pagedCommitsFetch(pages));

    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(entitiesOfType(sendEvent, "commit")).toHaveLength(500);
    expect(commitListCalls()).toHaveLength(5); // never asks for page 6
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        cap: 500,
        syncDepthDays: 90,
        owner: "acme",
        repo: "api",
      }),
      expect.stringContaining("commit backfill capped"),
    );
  });
});
