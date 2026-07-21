import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  runInTenantScope: vi.fn(),
  scopedSessionRun: vi.fn().mockResolvedValue({ records: [] }),
  scopedSessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  generateObjectFor: vi.fn(),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
}));

type HandlerCtx = {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
  };
};
let capturedHandler: ((ctx: HandlerCtx) => unknown) | null = null;
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

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("../../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    debug: mocks.loggerDebug,
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

await import("../ingestion.github-infer-features");

// ── Fixture data ──────────────────────────────────────────────────────────────

const BASE_SYMBOLS = [
  { name: "login", kind: "function", startLine: 0, endLine: 10 },
  { name: "AuthService", kind: "class", startLine: 12, endLine: 50 },
  { name: "verifyToken", kind: "function", startLine: 52, endLine: 60 },
];

const BASE_EVENT = {
  fileNaturalKey: "github:conn-gh-1:acme/api:src/auth.ts",
  symbols: BASE_SYMBOLS,
  orgId: "org-gh-1",
  workspaceId: "ws-gh-1",
  connectionId: "conn-gh-1",
};

const HIGH_CONFIDENCE_FEATURES = [
  {
    name: "OAuth Login",
    description: "Handles user authentication",
    relatedSymbolNames: ["login", "verifyToken"],
    confidence: 0.9,
  },
  {
    name: "Token Validation",
    description: "Validates JWT tokens",
    relatedSymbolNames: ["verifyToken"],
    confidence: 0.75,
  },
];

const MIXED_CONFIDENCE_FEATURES = [
  {
    name: "OAuth Login",
    description: "Handles user auth",
    relatedSymbolNames: ["login"],
    confidence: 0.9,
  },
  {
    name: "Low Confidence Feature",
    description: "Maybe?",
    relatedSymbolNames: [],
    confidence: 0.4,
  },
  {
    name: "Another Low",
    description: "Not sure",
    relatedSymbolNames: [],
    confidence: 0.55,
  },
];

function setupDefaultMocks(): void {
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );

  mocks.scopedSession.mockReturnValue({
    run: mocks.scopedSessionRun,
    close: mocks.scopedSessionClose,
  });

  mocks.generateObjectFor.mockResolvedValue({
    object: { features: HIGH_CONFIDENCE_FEATURES },
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  });
}

function makeStep(): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ingestion.github-infer-features Inngest function", () => {
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
      id: "ingestion-github-infer-features",
      retries: 2,
      concurrency: expect.objectContaining({
        limit: 5,
        key: "event.data.orgId",
      }),
    });
    expect(trigger).toMatchObject({ event: "ingestion/github.infer-features" });
  });

  it("calls generateObjectFor with ingestion surface telemetry", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.generateObjectFor).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({
          orgId: "org-gh-1",
          workspaceId: "ws-gh-1",
          surface: "ingestion",
          // OXA-1813: ingestion inference has no initiating message; messageId
          // must be a UUID or null — a non-UUID string flooded token_usage's
          // uuid execution_step_id column. The source now passes null.
          messageId: null,
        }),
      }),
    );
  });

  it("passes file natural key, language, and symbols in the prompt", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const [args] = mocks.generateObjectFor.mock.calls[0] as [
      { prompt: string },
    ];
    expect(args.prompt).toContain("github:conn-gh-1:acme/api:src/auth.ts");
    expect(args.prompt).toContain("typescript");
    expect(args.prompt).toContain("login");
    expect(args.prompt).toContain("AuthService");
  });

  it("MERGEs Feature nodes for features with confidence >= 0.6", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const mergeFeatureCalls = mocks.scopedSessionRun.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("MERGE (feat:Feature"),
    );
    // Both HIGH_CONFIDENCE_FEATURES have confidence >= 0.6.
    expect(mergeFeatureCalls.length).toBe(2);
  });

  it("uses correct natural key format for Feature nodes", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const mergeFeatureCalls = mocks.scopedSessionRun.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("MERGE (feat:Feature"),
    );

    expect(mergeFeatureCalls[0]![1]).toMatchObject({
      naturalKey: "feature:ws-gh-1:oauth-login",
      orgId: "org-gh-1",
      name: "OAuth Login",
    });
  });

  it("filters out features below the 0.6 confidence threshold", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { features: MIXED_CONFIDENCE_FEATURES },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    // Only "OAuth Login" (0.9) should pass — the others (0.4, 0.55) are below threshold.
    expect(result).toMatchObject({ featuresCreated: 1 });

    const mergeFeatureCalls = mocks.scopedSessionRun.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("MERGE (feat:Feature"),
    );
    expect(mergeFeatureCalls.length).toBe(1);
  });

  it("MERGEs :IMPLEMENTS edges from Feature to SourceFile carrying authority provenance", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const implementsCalls = mocks.scopedSessionRun.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("MERGE (feat)-[impl:IMPLEMENTS]->(f)"),
    );
    // One per accepted feature (2).
    expect(implementsCalls.length).toBe(2);
    // Every inferred edge carries { authority:'inferred', method } (spec finding 7).
    expect(implementsCalls[0]![0] as string).toContain(
      "impl.authority  = 'inferred'",
    );
  });

  it("does NOT MERGE any Feature→SourceSymbol edge (symbols are gone from the graph)", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const symbolImplementsCalls = mocks.scopedSessionRun.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" && (c[0] as string).includes("SourceSymbol"),
    );
    expect(symbolImplementsCalls.length).toBe(0);
  });

  it("returns { featuresCreated: 0 } when all features are below threshold", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: {
        features: [
          {
            name: "Low",
            description: "no",
            relatedSymbolNames: [],
            confidence: 0.3,
          },
          {
            name: "Also Low",
            description: "no",
            relatedSymbolNames: [],
            confidence: 0.5,
          },
        ],
      },
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toMatchObject({ featuresCreated: 0 });
    // No Neo4j writes should have occurred.
    expect(mocks.scopedSession).not.toHaveBeenCalled();
  });

  it("returns { featuresCreated: 0 } when features array is empty", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { features: [] },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toMatchObject({ featuresCreated: 0 });
    expect(mocks.scopedSession).not.toHaveBeenCalled();
  });

  it("returns fileNaturalKey and featuresCreated", async () => {
    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toMatchObject({
      fileNaturalKey: "github:conn-gh-1:acme/api:src/auth.ts",
      featuresCreated: 2,
    });
  });

  it("wraps all Neo4j calls inside runInTenantScope with orgId and workspaceId", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-gh-1", workspaceId: "ws-gh-1" }),
      expect.any(Function),
    );
  });

  it("slugifies feature names using lowercase and hyphens", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: {
        features: [
          {
            name: "User  Profile Management",
            description: "user profile",
            relatedSymbolNames: [],
            confidence: 0.8,
          },
        ],
      },
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    });

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const mergeFeatureCalls = mocks.scopedSessionRun.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("MERGE (feat:Feature"),
    );

    // "\s+" collapses multiple spaces to a single hyphen.
    expect(mergeFeatureCalls[0]![1]).toMatchObject({
      naturalKey: "feature:ws-gh-1:user-profile-management",
    });
  });
});
