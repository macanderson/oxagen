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
  defaultBranch: "main",
};

const TREE_RESPONSE = {
  sha: "abc123",
  url: "https://api.github.com/repos/acme/api/git/trees/main",
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

function setupDefaultMocks(): void {
  // Crypto
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    keyId: "key-1",
    adapter: {},
  });
  mocks.decrypt.mockResolvedValue(Buffer.from("ghp_test_token"));

  // Database: return oauth account row
  mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      execute: vi.fn().mockResolvedValue([{ access_token_enc: ACCESS_TOKEN_ENC }]),
    }),
  );

  // Tenancy
  mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());

  // GitHub API tree response
  mocks.fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(TREE_RESPONSE),
  });
}

function makeStep(overrides: Partial<HandlerCtx["step"]> = {}): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
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

  it("fetches the repo file tree from GitHub with Bearer auth", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.github.com/repos/acme/api/git/trees/main"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("Bearer"),
        }),
      }),
    );
  });

  it("filters tree to only .ts/.tsx/.py blobs with size > 0, excluding banned prefixes", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    // Should have dispatched events for: auth.ts, billing.ts, utils.py (3 files)
    // NOT for: node_modules, dist, README.md, empty.ts, tree entry
    expect(sendEvent).toHaveBeenCalled();
    const allEvents: unknown[] = sendEvent.mock.calls.flatMap((c) => {
      const payload = c[1];
      return Array.isArray(payload) ? payload : [payload];
    });
    expect(allEvents.length).toBe(3);
  });

  it("dispatches ingestion/github.parse-file events for each accepted file", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const allEvents: Array<{ name: string; data: unknown }> = sendEvent.mock.calls.flatMap(
      (c) => {
        const payload = c[1];
        return Array.isArray(payload) ? payload : [payload];
      },
    );

    const names = allEvents.map((e) => e.name);
    expect(names.every((n) => n === "ingestion/github.parse-file")).toBe(true);
  });

  it("dispatched events include owner, repo, sha, path, and connectionId", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const allEvents: Array<{ name: string; data: Record<string, unknown> }> = sendEvent.mock.calls.flatMap(
      (c) => {
        const payload = c[1];
        return Array.isArray(payload) ? payload : [payload];
      },
    );

    for (const ev of allEvents) {
      expect(ev.data).toMatchObject({
        connectionId: "conn-gh-1",
        orgId: "org-gh-1",
        workspaceId: "ws-gh-1",
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

  it("calls withSystemDb to update source_connections status to connected", async () => {
    // The update-status step calls withSystemDb. Verify withSystemDb is called
    // more than once (once for token fetch + once for update-status).
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });

  it("returns connectionId, owner, repo, and fileCount", async () => {
    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(result).toMatchObject({
      connectionId: "conn-gh-1",
      owner: "acme",
      repo: "api",
      fileCount: 3,
    });
  });

  it("throws when GitHub tree API returns non-OK status", async () => {
    mocks.fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

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
    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...TREE_RESPONSE, tree: largeTrees }),
    });

    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    // With BATCH_SIZE=50, 75 files → 2 sendEvent calls.
    expect(sendEvent.mock.calls.length).toBe(2);
  });
});
