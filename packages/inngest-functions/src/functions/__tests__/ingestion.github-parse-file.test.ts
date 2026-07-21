import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  runInTenantScope: vi.fn(),
  scopedSessionRun: vi
    .fn()
    .mockResolvedValue({ records: [{ get: () => "file-public-id-1" }] }),
  scopedSessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  parseSourceFile: vi.fn(),
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
// Capture registration args before clearAllMocks wipes the call record.
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

// sql tagged template literal that returns a plain object carrying the strings
// so the withSystemDb mock can distinguish the token read from the scope read.
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

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

// @oxagen/ontology/natural-key is a pure string module — use the REAL impl so
// the canonical-key assertions exercise the shared builder, not a stub.

vi.mock("@oxagen/ingestion/parsers", () => ({
  parseSourceFile: mocks.parseSourceFile,
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

vi.stubGlobal("fetch", mocks.fetchMock);

await import("../ingestion.github-parse-file");

// ── Fixture data ──────────────────────────────────────────────────────────────

const BASE_EVENT = {
  connectionId: "conn-gh-1",
  orgId: "org-gh-1",
  workspaceId: "ws-gh-1",
  owner: "acme",
  repo: "api",
  sha: "blob-sha-auth",
  path: "src/auth.ts",
  repositoryId: "crepo-1",
  generationId: "gen-1",
  commitSha: "commit-abc123",
  treeSha: "tree-def456",
  scopeKey: "src",
  codeScopeId: "scope-1",
};

const ACCESS_TOKEN_ENC = {
  keyId: "key-1",
  ciphertext: Buffer.from("token123").toString("base64"),
};

const PARSED_SYMBOLS = [
  { name: "login", kind: "function", startLine: 0, endLine: 10 },
  { name: "AuthService", kind: "class", startLine: 12, endLine: 50 },
];

const SCOPE_ROWS = [
  { scope_key: "packages/api" },
  { scope_key: "packages/billing" },
];

function setupDefaultMocks(): void {
  mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({
    keyId: "key-1",
    adapter: {},
  });
  mocks.decrypt.mockResolvedValue(Buffer.from("ghp_test_token"));

  // Two distinct Postgres reads flow through withSystemDb: the oauth token
  // (SELECT ... access_token_enc) and the generation scope keys (SELECT
  // scope_key ...). Distinguish by the query text so the scope read never gets
  // a token row (advisor's mock-collision note).
  mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      execute: vi
        .fn()
        .mockImplementation((q: { strings?: TemplateStringsArray }) => {
          const text = q?.strings ? Array.from(q.strings).join(" ") : "";
          if (text.includes("scope_key")) return Promise.resolve(SCOPE_ROWS);
          return Promise.resolve([{ access_token_enc: ACCESS_TOKEN_ENC }]);
        }),
    }),
  );

  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );

  mocks.fetchMock.mockResolvedValue({
    ok: true,
    headers: { get: (_k: string) => "1024" },
    text: () => Promise.resolve("export function login() {}"),
  });

  // Default parse result carries NO imports → no scope-dependency aggregation.
  mocks.parseSourceFile.mockResolvedValue({
    language: "typescript",
    symbols: PARSED_SYMBOLS,
  });

  mocks.scopedSession.mockReturnValue({
    run: mocks.scopedSessionRun,
    close: mocks.scopedSessionClose,
  });

  // The project-source-file MERGE returns the file publicId.
  mocks.scopedSessionRun.mockResolvedValue({
    records: [{ get: (_k: string) => "file-public-id-1" }],
  });
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

/** All (name, payload) pairs sent to a generation-file-done event. */
function doneEvents(step: HandlerCtx["step"]) {
  const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
  return sendEvent.mock.calls.filter(
    (c: unknown[]) =>
      (c[1] as { name?: string } | undefined)?.name ===
      "ingestion/github.generation-file-done",
  );
}

/** All Cypher strings passed to scopedSession().run(). */
function allCypher(): string[] {
  return mocks.scopedSessionRun.mock.calls
    .map((c: unknown[]) => c[0])
    .filter((c): c is string => typeof c === "string");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ingestion.github-parse-file projector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("registers with correct id, retries, and concurrency", () => {
    expect(capturedCreateFunctionArgs).not.toBeNull();
    const [opts, trigger] = capturedCreateFunctionArgs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opts).toMatchObject({
      id: "ingestion-github-parse-file",
      retries: 3,
      concurrency: expect.objectContaining({
        limit: 5,
        key: "event.data.orgId",
      }),
    });
    expect(trigger).toMatchObject({ event: "ingestion/github.parse-file" });
  });

  it("MERGEs a slim, commit-addressed SourceFile on the canonical (connectionId-less) key", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const fileCall = mocks.scopedSessionRun.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("MERGE (f:SourceFile"),
    );
    expect(fileCall).toBeDefined();
    const [cypher, params] = fileCall as [string, Record<string, unknown>];
    // Canonical identity — no connectionId in the key.
    expect(params.naturalKey).toBe("github:acme/api:src/auth.ts");
    // Commit-addressed slim props.
    expect(params).toMatchObject({
      path: "src/auth.ts",
      language: "typescript",
      commitSha: "commit-abc123",
      treeSha: "tree-def456",
      generationId: "gen-1",
      scopeKey: "src",
    });
    // Still graph-visible + still sourced-from the connection.
    expect(cypher).toContain("f:GraphNode");
    expect(cypher).toContain("SOURCED_FROM");
  });

  it("links the SourceFile to its CodeScope with IN_SCOPE (github:{owner}/{repo}:scope:{scopeKey})", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const fileCall = mocks.scopedSessionRun.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && (c[0] as string).includes("IN_SCOPE"),
    );
    expect(fileCall).toBeDefined();
    const [cypher, params] = fileCall as [string, Record<string, unknown>];
    expect(cypher).toContain("MERGE (scope:CodeScope");
    expect(cypher).toContain("[insc:IN_SCOPE]");
    expect(params.scopeNaturalKey).toBe("github:acme/api:scope:src");
  });

  it("writes NO SourceSymbol / SourceChunk / embedding / plaintext content (four-store law)", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    for (const cypher of allCypher()) {
      expect(cypher).not.toContain("SourceSymbol");
      expect(cypher).not.toContain("SourceChunk");
      expect(cypher).not.toContain("CONTAINS");
      expect(cypher).not.toContain("HAS_CHUNK");
      expect(cypher).not.toMatch(/embedding/i);
      expect(cypher).not.toMatch(/\.content\b/);
    }
  });

  it("aggregates a cross-scope import into a CodeScope DEPENDS_ON edge carrying count", async () => {
    mocks.parseSourceFile.mockResolvedValueOnce({
      language: "typescript",
      symbols: PARSED_SYMBOLS,
      imports: [
        { specifier: "../../billing/src/grants" }, // cross-scope → packages/billing
        { specifier: "./local" }, // same scope → skipped
        { specifier: "react" }, // bare npm → ignored
      ],
    });
    const event = {
      ...BASE_EVENT,
      path: "packages/api/src/handler.ts",
      scopeKey: "packages/api",
    };
    const step = makeStep();
    await capturedHandler!({ event: { data: event }, step });

    const depCall = mocks.scopedSessionRun.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && (c[0] as string).includes("DEPENDS_ON"),
    );
    expect(depCall).toBeDefined();
    const [cypher, params] = depCall as [string, Record<string, unknown>];
    expect(cypher).toContain("dep.count     = 1");
    expect(cypher).toContain("dep.count     = coalesce(dep.count, 0) + 1");
    expect(params.fromScopeKey).toBe("github:acme/api:scope:packages/api");
    expect(params.targets).toEqual([
      {
        naturalKey: "github:acme/api:scope:packages/billing",
        scopeKey: "packages/billing",
      },
    ]);
  });

  it("does NOT aggregate dependencies when there are no relative imports", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const depCall = mocks.scopedSessionRun.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && (c[0] as string).includes("DEPENDS_ON"),
    );
    expect(depCall).toBeUndefined();
  });

  it("fires infer-features with the CANONICAL fileNaturalKey when language known + symbols exist", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(sendEvent).toHaveBeenCalledWith(
      "infer-features",
      expect.objectContaining({
        name: "ingestion/github.infer-features",
        data: expect.objectContaining({
          fileNaturalKey: "github:acme/api:src/auth.ts",
          orgId: "org-gh-1",
          workspaceId: "ws-gh-1",
          connectionId: "conn-gh-1",
          symbols: PARSED_SYMBOLS,
        }),
      }),
    );
  });

  it("does NOT fire infer-features when language is unknown", async () => {
    mocks.parseSourceFile.mockResolvedValueOnce({
      language: "unknown",
      symbols: [],
    });
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const inferCalls = sendEvent.mock.calls.filter(
      (c: unknown[]) => c[0] === "infer-features",
    );
    expect(inferCalls).toHaveLength(0);
  });

  // ── generation-file-done: exactly once per event, on success AND every skip ──

  it("emits generation-file-done EXACTLY ONCE with skipped:false on success", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const done = doneEvents(step);
    expect(done).toHaveLength(1);
    expect((done[0]![1] as { data: unknown }).data).toEqual({
      orgId: "org-gh-1",
      workspaceId: "ws-gh-1",
      generationId: "gen-1",
      skipped: false,
    });
  });

  it("emits generation-file-done ONCE with skipped:true when the file is too large", async () => {
    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: (_k: string) => "1100000" },
      text: () => Promise.resolve("x".repeat(1100001)),
    });
    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toMatchObject({ skipped: true, reason: "file_too_large" });
    expect(mocks.parseSourceFile).not.toHaveBeenCalled();
    const done = doneEvents(step);
    expect(done).toHaveLength(1);
    expect((done[0]![1] as { data: { skipped: boolean } }).data.skipped).toBe(
      true,
    );
  });

  it("emits generation-file-done ONCE with skipped:true for binary content", async () => {
    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: (_k: string) => "12" },
      text: () => Promise.resolve("PNG binary"),
    });
    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toMatchObject({ skipped: true, reason: "binary" });
    expect(mocks.parseSourceFile).not.toHaveBeenCalled();
    const done = doneEvents(step);
    expect(done).toHaveLength(1);
    expect((done[0]![1] as { data: { skipped: boolean } }).data.skipped).toBe(
      true,
    );
  });

  it("emits generation-file-done ONCE with skipped:true when the parser throws", async () => {
    mocks.parseSourceFile.mockRejectedValueOnce(new Error("tree-sitter boom"));
    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toMatchObject({ skipped: true, reason: "parse_failed" });
    const done = doneEvents(step);
    expect(done).toHaveLength(1);
    expect((done[0]![1] as { data: { skipped: boolean } }).data.skipped).toBe(
      true,
    );
    // A parser throw must be swallowed, never propagated (would retry forever
    // and wedge the generation gate).
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });

  it("does NOT emit generation-file-done when the token fetch throws (retryable — the retry emits it)", async () => {
    mocks.withSystemDb.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({ execute: vi.fn().mockResolvedValue([]) }),
    );
    const step = makeStep();
    await expect(
      capturedHandler!({ event: { data: BASE_EVENT }, step }),
    ).rejects.toThrow(/no oauth token/);
    expect(doneEvents(step)).toHaveLength(0);
  });

  it("does NOT emit generation-file-done when the GitHub blob API errors (retryable)", async () => {
    mocks.fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
    });
    const step = makeStep();
    await expect(
      capturedHandler!({ event: { data: BASE_EVENT }, step }),
    ).rejects.toThrow(/GitHub blob API returned 403/);
    expect(doneEvents(step)).toHaveLength(0);
  });

  it("returns path, fileId, language, symbolCount, skipped:false on success", async () => {
    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toMatchObject({
      path: "src/auth.ts",
      fileId: "file-public-id-1",
      language: "typescript",
      symbolCount: 2,
      skipped: false,
    });
  });
});
