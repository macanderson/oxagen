import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  getConnector: vi.fn(),
  renderEntityText: vi.fn().mockReturnValue("task  My PR  state:open"),
  embedEntity: vi.fn().mockResolvedValue(undefined),
  upsertEntityNode: vi.fn().mockResolvedValue({ nodeId: "neo4j-node-1" }),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
  // scopedSession mock: default returns { found: false } for dedup-pass-a
  scopedSessionRun: vi.fn().mockResolvedValue({ records: [] }),
  scopedSessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  // resolveEntity mock for dedup-pass-b
  resolveEntity: vi.fn(),
}));

type HandlerCtx = {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
    sendEvent: (name: string, payload: unknown) => Promise<void>;
  };
};
let capturedHandler: ((ctx: HandlerCtx) => unknown) | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
  },
);

vi.mock("../../inngest", () => ({
  inngest: { createFunction: mocks.createFunction },
}));

vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: mocks.getConnector,
}));

vi.mock("@oxagen/ingestion/embed", () => ({
  renderEntityText: mocks.renderEntityText,
  embedEntity: mocks.embedEntity,
}));

vi.mock("@oxagen/ingestion/mutations", () => ({
  upsertEntityNode: mocks.upsertEntityNode,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
  };
});

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/ingestion/dedup", () => ({
  resolveEntity: mocks.resolveEntity,
}));

vi.mock("../../logger", () => ({
  logger: { info: mocks.loggerInfo, debug: mocks.loggerDebug, error: vi.fn() },
}));

await import("../ingestion.pipeline");

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_EVENT = {
  connectionId: "conn-abc",
  workspaceId: "ws-xyz",
  orgId: "org-123",
  connectorType: "github",
  sourceRecordType: "pull_request",
  idempotencyKey: "github:conn-abc:pull_request:42",
  payload: { number: 42, title: "Add OAuth", state: "open" },
  receivedAt: "2026-06-09T00:00:00Z",
};

const NORMALIZED = {
  externalId: "42",
  externalUrl: "https://github.com/org/repo/pull/42",
  displayName: "Add OAuth",
  properties: { title: "Add OAuth", state: "open", author: "mac" },
};

function makeStep(overrides: Partial<HandlerCtx["step"]> = {}): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ingestion.pipeline Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
    // Default: scopedSession returns no records (dedup-pass-a misses)
    mocks.scopedSession.mockReturnValue({
      run: mocks.scopedSessionRun,
      close: mocks.scopedSessionClose,
    });
    mocks.scopedSessionRun.mockResolvedValue({ records: [] });
    // Default: resolveEntity creates a new principal
    mocks.resolveEntity.mockResolvedValue({
      principalNodeId: "neo4j-node-1",
      action: "created_principal",
      confidence: 1.0,
    });
  });

  describe("no entity type mapping configured", () => {
    it("returns { skipped: true } when no mapping row exists", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({ execute: vi.fn().mockResolvedValue([]) }),
      );

      const step = makeStep();
      const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(result).toEqual({ skipped: true });
    });

    it("does not call embedEntity or upsertEntityNode when skipped", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({ execute: vi.fn().mockResolvedValue([]) }),
      );

      const step = makeStep();
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(mocks.embedEntity).not.toHaveBeenCalled();
      expect(mocks.upsertEntityNode).not.toHaveBeenCalled();
    });
  });

  describe("mapping exists — happy path", () => {
    beforeEach(() => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi.fn().mockResolvedValue([
            { oxagen_entity_type: "task", property_mappings: { title: "name" } },
          ]),
        }),
      );
    });

    it("returns naturalKey and action on success", async () => {
      const step = makeStep();
      const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(result).toEqual({
        naturalKey: "github:conn-abc:42",
        action: "created_principal",
      });
    });

    it("runs 5 step.run calls and 1 step.sendEvent", async () => {
      const stepRun = vi.fn(async (_name: string, fn: () => unknown) => fn());
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ run: stepRun, sendEvent });
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(stepRun).toHaveBeenCalledTimes(5);
      expect(stepRun).toHaveBeenNthCalledWith(1, "normalize-and-map", expect.any(Function));
      expect(stepRun).toHaveBeenNthCalledWith(2, "dedup-pass-a", expect.any(Function));
      expect(stepRun).toHaveBeenNthCalledWith(3, "dedup-pass-b", expect.any(Function));
      expect(stepRun).toHaveBeenNthCalledWith(4, "upsert-node", expect.any(Function));
      expect(stepRun).toHaveBeenNthCalledWith(5, "embed", expect.any(Function));
      expect(sendEvent).toHaveBeenCalledWith("schedule-inference", expect.any(Object));
    });

    it("calls getConnector with the connectorType", async () => {
      const step = makeStep();
      await capturedHandler!({ event: { data: BASE_EVENT }, step });
      expect(mocks.getConnector).toHaveBeenCalledWith("github");
    });

    it("applies property mappings from the entity_type_mappings row", async () => {
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi.fn().mockResolvedValue([
            { oxagen_entity_type: "task", property_mappings: { title: "name" } },
          ]),
        }),
      );

      const step = makeStep();
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      // renderEntityText should receive the remapped properties (title → name).
      const renderCall = mocks.renderEntityText.mock.calls[0]!;
      expect(renderCall[0]).toBe("task");
      expect(renderCall[2]).toMatchObject({ name: "Add OAuth" });
      expect(renderCall[2]).not.toHaveProperty("title");
    });

    it("fires ingestion/entity.infer event as the 6th step action", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(sendEvent).toHaveBeenCalledWith(
        "schedule-inference",
        expect.objectContaining({
          name: "ingestion/entity.infer",
          data: expect.objectContaining({
            entityType: "task",
            orgId: "org-123",
            workspaceId: "ws-xyz",
          }),
        }),
      );
    });

    it("calls embedEntity with correct EmbedRequest", async () => {
      const step = makeStep();
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(mocks.embedEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "task",
          orgId: "org-123",
          workspaceId: "ws-xyz",
          connectionId: "conn-abc",
          text: expect.any(String),
        }),
      );
    });

    it("calls upsertEntityNode with the assembled mutation", async () => {
      const step = makeStep();
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(mocks.upsertEntityNode).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "task",
          naturalKey: "github:conn-abc:42",
          orgId: "org-123",
          workspaceId: "ws-xyz",
        }),
        "org-123",
      );
    });
  });

  describe("error propagation (step retry)", () => {
    it("propagates upsertEntityNode error so Inngest retries the step", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi.fn().mockResolvedValue([
            { oxagen_entity_type: "task", property_mappings: {} },
          ]),
        }),
      );
      mocks.upsertEntityNode.mockRejectedValueOnce(new Error("Neo4j unavailable"));

      const step = makeStep();
      await expect(capturedHandler!({ event: { data: BASE_EVENT }, step })).rejects.toThrow(
        "Neo4j unavailable",
      );
    });

    it("propagates embedEntity error for retry", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi.fn().mockResolvedValue([
            { oxagen_entity_type: "task", property_mappings: {} },
          ]),
        }),
      );
      mocks.embedEntity.mockRejectedValueOnce(new Error("AI Gateway timeout"));

      const step = makeStep();
      await expect(capturedHandler!({ event: { data: BASE_EVENT }, step })).rejects.toThrow(
        "AI Gateway timeout",
      );
    });
  });

  describe("dedup pass A (naturalKey found)", () => {
    it("returns updated_principal action when pass A finds an existing node", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi.fn().mockResolvedValue([
            { oxagen_entity_type: "task", property_mappings: {} },
          ]),
        }),
      );

      // Override step.run for dedup-pass-a to simulate a found node.
      const stepRun = vi.fn(async (name: string, fn: () => unknown) => {
        if (name === "dedup-pass-a") {
          return { found: true, nodeId: "neo4j-existing-node" };
        }
        return fn();
      });

      const step = makeStep({ run: stepRun });
      const result = await capturedHandler!({ event: { data: BASE_EVENT }, step });
      expect(result).toMatchObject({ action: "updated_principal" });
    });
  });
});
