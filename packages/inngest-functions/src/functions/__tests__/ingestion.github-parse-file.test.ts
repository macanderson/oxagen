import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  runInTenantScope: vi.fn(),
  scopedSessionRun: vi.fn().mockResolvedValue({ records: [{ get: () => "file-public-id-1" }] }),
  scopedSessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  parseSourceFile: vi.fn(),
  embedText: vi.fn().mockResolvedValue(Array.from({ length: 1536 }, () => 0.1)),
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

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/ingestion/parsers", () => ({
  parseSourceFile: mocks.parseSourceFile,
}));

vi.mock("@oxagen/ai", () => ({
  embedText: mocks.embedText,
}));

vi.mock("@oxagen/crypto", () => ({
  createIngestionCryptoAdapter: mocks.createIngestionCryptoAdapter,
  decrypt: mocks.decrypt,
}));

vi.mock("../../logger", () => ({
  logger: { info: mocks.loggerInfo, debug: mocks.loggerDebug, error: vi.fn(), warn: vi.fn() },
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
  sha: "sha-auth",
  path: "src/auth.ts",
};

const ACCESS_TOKEN_ENC = { keyId: "key-1", ciphertext: Buffer.from("token123").toString("base64") };

const PARSED_SYMBOLS = [
  { name: "login", kind: "function", startLine: 0, endLine: 10 },
  { name: "AuthService", kind: "class", startLine: 12, endLine: 50 },
];

function setupDefaultMocks(): void {
  mocks.createIngestionCryptoAdapter.mockReturnValue({ keyId: "key-1", adapter: {} });
  mocks.decrypt.mockResolvedValue(Buffer.from("ghp_test_token"));

  mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      execute: vi.fn().mockResolvedValue([{ access_token_enc: ACCESS_TOKEN_ENC }]),
    }),
  );

  mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());

  mocks.fetchMock.mockResolvedValue({
    ok: true,
    headers: { get: (_k: string) => "1024" },
    text: () => Promise.resolve("export function login() {}"),
  });

  mocks.parseSourceFile.mockResolvedValue({
    language: "typescript",
    symbols: PARSED_SYMBOLS,
  });

  mocks.scopedSession.mockReturnValue({
    run: mocks.scopedSessionRun,
    close: mocks.scopedSessionClose,
  });

  // First scopedSession.run call (upsert-source-file) returns fileId.
  mocks.scopedSessionRun.mockResolvedValue({
    records: [{ get: (_k: string) => "file-public-id-1" }],
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

describe("ingestion.github-parse-file Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("registers with correct id, retries, and concurrency", () => {
    expect(capturedCreateFunctionArgs).not.toBeNull();
    const [opts, trigger] = capturedCreateFunctionArgs as [Record<string, unknown>, Record<string, unknown>];
    expect(opts).toMatchObject({
      id: "ingestion-github-parse-file",
      retries: 3,
      concurrency: expect.objectContaining({ limit: 20, key: "event.data.orgId" }),
    });
    expect(trigger).toMatchObject({ event: "ingestion/github.parse-file" });
  });

  it("fetches access token from oauth_accounts via withSystemDb", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.withSystemDb).toHaveBeenCalled();
    expect(mocks.decrypt).toHaveBeenCalled();
  });

  it("fetches raw blob content with Accept: application/vnd.github.v3.raw", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/repos/acme/api/git/blobs/sha-auth`),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github.v3.raw",
        }),
      }),
    );
  });

  it("calls parseSourceFile with the file path and content", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.parseSourceFile).toHaveBeenCalledWith(
      "src/auth.ts",
      expect.any(String),
    );
  });

  it("calls scopedSession to MERGE SourceFile node in Neo4j", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.scopedSession).toHaveBeenCalled();
    expect(mocks.scopedSessionRun).toHaveBeenCalledWith(
      expect.stringContaining("MERGE (f:SourceFile"),
      expect.objectContaining({
        naturalKey: `github:conn-gh-1:acme/api:src/auth.ts`,
        orgId: "org-gh-1",
        path: "src/auth.ts",
        language: "typescript",
      }),
    );
  });

  it("calls scopedSession to MERGE SourceSymbol nodes when symbols exist", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const mergeSymbolCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("MERGE (s:SourceSymbol"),
    );
    expect(mergeSymbolCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("uses correct symbol natural key format", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const mergeSymbolCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("MERGE (s:SourceSymbol"),
    );

    // First symbol: login, kind: function
    expect(mergeSymbolCalls[0]![1]).toMatchObject({
      naturalKey: "github:conn-gh-1:acme/api:src/auth.ts:function:login",
    });
  });

  it("calls embedText with path + language + symbol names", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.embedText).toHaveBeenCalledWith(
      expect.stringContaining("src/auth.ts"),
      expect.objectContaining({
        telemetry: expect.objectContaining({
          orgId: "org-gh-1",
          surface: "ingestion",
        }),
      }),
    );

    const [text] = mocks.embedText.mock.calls[0] as [string, unknown];
    expect(text).toContain("typescript");
    expect(text).toContain("login");
    expect(text).toContain("AuthService");
  });

  it("fires ingestion/github.infer-features event when language is known and symbols exist", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(sendEvent).toHaveBeenCalledWith(
      "infer-features",
      expect.objectContaining({
        name: "ingestion/github.infer-features",
        data: expect.objectContaining({
          fileNaturalKey: "github:conn-gh-1:acme/api:src/auth.ts",
          orgId: "org-gh-1",
          workspaceId: "ws-gh-1",
          connectionId: "conn-gh-1",
          symbols: PARSED_SYMBOLS,
        }),
      }),
    );
  });

  it("does NOT fire infer-features when language is unknown", async () => {
    mocks.parseSourceFile.mockResolvedValueOnce({ language: "unknown", symbols: [] });

    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire infer-features when symbols array is empty", async () => {
    mocks.parseSourceFile.mockResolvedValueOnce({ language: "typescript", symbols: [] });

    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;

    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("returns { skipped: true } when file content exceeds 500KB", async () => {
    mocks.fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: (_k: string) => "600000" },
      text: () => Promise.resolve("x".repeat(600001)),
    });

    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(result).toMatchObject({ skipped: true, reason: "file_too_large" });
    expect(mocks.parseSourceFile).not.toHaveBeenCalled();
  });

  it("returns path, fileId, language, and symbolCount on success", async () => {
    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(result).toMatchObject({
      path: "src/auth.ts",
      language: "typescript",
      symbolCount: 2,
    });
  });

  it("does NOT upsert symbols when parse returns no symbols", async () => {
    mocks.parseSourceFile.mockResolvedValueOnce({ language: "typescript", symbols: [] });

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const mergeSymbolCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("MERGE (s:SourceSymbol"),
    );
    expect(mergeSymbolCalls.length).toBe(0);
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

  it("throws when GitHub blob API returns non-OK status", async () => {
    mocks.fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
    });

    const step = makeStep();
    await expect(capturedHandler!({ event: { data: BASE_EVENT }, step })).rejects.toThrow(
      /GitHub blob API returned 403/,
    );
  });
});
