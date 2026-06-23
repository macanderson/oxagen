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
  loggerError: vi.fn(),
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
    error: mocks.loggerError,
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

await import("../ingestion.semantic-edge-infer");

// ── Fixture data ──────────────────────────────────────────────────────────────

const BASE_EVENT = {
  nodeId: "node-uuid-1",
  entityType: "pull_request",
  propertiesSnapshot: {
    title: "feat: add OAuth login",
    body: "Implements the OAuth login feature using GitHub provider",
    assignees: ["alice", "bob"],
    labels: ["feature", "auth"],
  },
  workspaceId: "ws-1",
  orgId: "org-1",
};

const HIGH_CONFIDENCE_EDGES = [
  { targetType: "Feature", targetName: "OAuth Login", relationshipType: "IMPLEMENTS", confidence: 0.92 },
  { targetType: "Service", targetName: "Auth Service", relationshipType: "BELONGS_TO", confidence: 0.88 },
];

const MIXED_CONFIDENCE_EDGES = [
  { targetType: "Feature", targetName: "OAuth Login", relationshipType: "IMPLEMENTS", confidence: 0.9 },
  { targetType: "Service", targetName: "Unknown Service", relationshipType: "BELONGS_TO", confidence: 0.6 },
];

function setupDefaultMocks(): void {
  mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());

  mocks.scopedSession.mockReturnValue({
    run: mocks.scopedSessionRun,
    close: mocks.scopedSessionClose,
  });

  mocks.generateObjectFor.mockResolvedValue({
    object: { edges: HIGH_CONFIDENCE_EDGES },
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  });
}

function makeStep(): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ingestion.semantic-edge-infer Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("registers with correct id, retries, and concurrency", () => {
    expect(capturedCreateFunctionArgs).not.toBeNull();
    const [opts, trigger] = capturedCreateFunctionArgs as [Record<string, unknown>, Record<string, unknown>];
    expect(opts).toMatchObject({
      id: "ingestion-semantic-edge-infer",
      retries: 2,
      concurrency: expect.objectContaining({ limit: 5, key: "event.data.orgId" }),
    });
    expect(trigger).toMatchObject({ event: "ingestion/entity.infer" });
  });

  it("calls generateObjectFor with the entity type and properties in the prompt", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.generateObjectFor).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("pull_request"),
        telemetry: expect.objectContaining({
          orgId: "org-1",
          workspaceId: "ws-1",
          surface: "ingestion",
          // messageId is null: non-UUID strings must not flood token_usage.execution_step_id (OXA-1813)
          messageId: null,
        }),
      }),
    );
  });

  it("calls generateObjectFor with ingestion surface", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const [args] = mocks.generateObjectFor.mock.calls[0] as [{ telemetry: { surface: string } }];
    expect(args.telemetry.surface).toBe("ingestion");
  });

  it("writes InferredEdge nodes to Neo4j for all inferred edges", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    // MERGE InferredEdge is called once per edge.
    const inferenceMergeCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("MERGE (ie:InferredEdge"),
    );
    expect(inferenceMergeCalls.length).toBe(2);
  });

  it("sets approvalStatus = 'approved' for edges at or above 0.85 threshold", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const mergeCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("MERGE (ie:InferredEdge"),
    );

    // Both HIGH_CONFIDENCE_EDGES are >= 0.85.
    for (const call of mergeCalls) {
      const params = call[1] as Record<string, unknown>;
      expect(params.approvalStatus).toBe("approved");
    }
  });

  it("sets approvalStatus = 'pending' for edges below 0.85 threshold", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { edges: MIXED_CONFIDENCE_EDGES },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const mergeCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("MERGE (ie:InferredEdge"),
    );

    const statuses = mergeCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).approvalStatus);
    expect(statuses).toContain("approved");   // 0.9 edge
    expect(statuses).toContain("pending");    // 0.6 edge
  });

  it("creates permanent :SEMANTIC_EDGE relationships for auto-accepted edges", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const relMergeCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("SEMANTIC_EDGE"),
    );
    // Both HIGH_CONFIDENCE_EDGES are auto-accepted.
    expect(relMergeCalls.length).toBe(2);
  });

  it("does NOT create permanent relationship for pending edges", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { edges: [MIXED_CONFIDENCE_EDGES[1]!] }, // 0.6 = pending only
      usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
    });

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const relMergeCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("SEMANTIC_EDGE"),
    );
    expect(relMergeCalls.length).toBe(0);
  });

  it("returns edgesCreated=0 and autoAccepted=0 when no edges are inferred", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { edges: [] },
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    });

    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(result).toMatchObject({ nodeId: "node-uuid-1", edgesCreated: 0, autoAccepted: 0 });
    expect(mocks.scopedSession).not.toHaveBeenCalled();
  });

  it("returns correct edgesCreated and autoAccepted counts", async () => {
    const step = makeStep();
    const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });

    // Both edges are >= 0.85 (auto-accepted).
    expect(result).toMatchObject({ edgesCreated: 2, autoAccepted: 2 });
  });

  it("closes the Neo4j session after writing edges", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.scopedSessionClose).toHaveBeenCalledOnce();
  });

  it("uses KnowledgeNode as the target label for new target nodes", async () => {
    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const relMergeCalls = mocks.scopedSessionRun.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("KnowledgeNode"),
    );
    expect(relMergeCalls.length).toBeGreaterThan(0);
  });
});
