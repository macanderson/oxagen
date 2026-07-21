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
  /** Inngest's run id (OXA-1932) — threaded to upsertEntityNode for conformance-event idempotency. */
  runId?: string;
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

function makeStep(
  overrides: Partial<HandlerCtx["step"]> = {},
): HandlerCtx["step"] {
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
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

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
            {
              oxagen_entity_type: "task",
              property_mappings: { title: "name" },
            },
          ]),
        }),
      );
    });

    it("returns naturalKey and action on success", async () => {
      const step = makeStep();
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

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
      expect(stepRun).toHaveBeenNthCalledWith(
        1,
        "normalize-and-map",
        expect.any(Function),
      );
      expect(stepRun).toHaveBeenNthCalledWith(
        2,
        "dedup-pass-a",
        expect.any(Function),
      );
      expect(stepRun).toHaveBeenNthCalledWith(
        3,
        "dedup-pass-b",
        expect.any(Function),
      );
      expect(stepRun).toHaveBeenNthCalledWith(
        4,
        "upsert-node",
        expect.any(Function),
      );
      expect(stepRun).toHaveBeenNthCalledWith(5, "embed", expect.any(Function));
      expect(sendEvent).toHaveBeenCalledWith(
        "schedule-change-event",
        expect.any(Object),
      );
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
            {
              oxagen_entity_type: "task",
              property_mappings: { title: "name" },
            },
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

    it("fires ingestion/entity.created after the node write", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(sendEvent).toHaveBeenCalledWith(
        "schedule-change-event",
        expect.objectContaining({
          name: "ingestion/entity.created",
          data: expect.objectContaining({
            entityType: "task",
            orgId: "org-123",
            workspaceId: "ws-xyz",
            naturalKey: "github:conn-abc:42",
          }),
        }),
      );
    });

    it("includes isNew=true for a created_principal action in entity.created event", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      const events = [sendEvent.mock.calls[0]![1]] as Array<{
        name: string;
        data: Record<string, unknown>;
      }>;
      const createdEvent = events.find(
        (e) => e.name === "ingestion/entity.created",
      );
      expect(createdEvent?.data["isNew"]).toBe(true);
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
        expect.objectContaining({ runId: undefined }),
      );
    });

    it("threads the Inngest runId to upsertEntityNode so retried steps re-derive the same conformance-event id (OXA-1932)", async () => {
      const step = makeStep();
      await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
        runId: "01HXYZ-run-abc",
      });

      expect(mocks.upsertEntityNode).toHaveBeenCalledWith(
        expect.objectContaining({ naturalKey: "github:conn-abc:42" }),
        "org-123",
        expect.objectContaining({ runId: "01HXYZ-run-abc" }),
      );
    });

    it("runs upsert-node (step 4) and embed (step 5) inside an active tenant scope (regression: OXA-1790 no_tenant_scope)", async () => {
      // Production invariant: upsertEntityNode → scopedSession() and
      // embedEntity → upsertEmbedding → scopedSession() THROW without an active
      // tenant scope. Each Inngest step.run is a separate execution, so the
      // scope opened in steps 1–3 does not carry over — steps 4 and 5 must open
      // their own. Previously they did not, so all ingestion 500'd in prod with
      // TenantScopeError(no_tenant_scope).
      //
      // Track scope depth through the runInTenantScope mock and record the depth
      // observed when each Neo4j-writing mutation actually runs. A missing wrap
      // shows up as depth 0.
      let scopeDepth = 0;
      const depthWhenCalled: Record<string, number> = {};
      mocks.runInTenantScope.mockImplementation(
        async (_scope: unknown, fn: () => unknown) => {
          scopeDepth++;
          try {
            return await fn();
          } finally {
            scopeDepth--;
          }
        },
      );
      mocks.upsertEntityNode.mockImplementation(() => {
        depthWhenCalled.upsert = scopeDepth;
        return Promise.resolve({ nodeId: "neo4j-node-1" });
      });
      mocks.embedEntity.mockImplementation(() => {
        depthWhenCalled.embed = scopeDepth;
        return Promise.resolve(undefined);
      });

      const step = makeStep();
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(depthWhenCalled.upsert).toBeGreaterThan(0);
      expect(depthWhenCalled.embed).toBeGreaterThan(0);
    });
  });

  describe("error propagation (step retry)", () => {
    it("propagates upsertEntityNode error so Inngest retries the step", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi
            .fn()
            .mockResolvedValue([
              { oxagen_entity_type: "task", property_mappings: {} },
            ]),
        }),
      );
      mocks.upsertEntityNode.mockRejectedValueOnce(
        new Error("Neo4j unavailable"),
      );

      const step = makeStep();
      await expect(
        capturedHandler!({ event: { data: BASE_EVENT }, step }),
      ).rejects.toThrow("Neo4j unavailable");
    });

    it("propagates embedEntity error for retry", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi
            .fn()
            .mockResolvedValue([
              { oxagen_entity_type: "task", property_mappings: {} },
            ]),
        }),
      );
      mocks.embedEntity.mockRejectedValueOnce(new Error("AI Gateway timeout"));

      const step = makeStep();
      await expect(
        capturedHandler!({ event: { data: BASE_EVENT }, step }),
      ).rejects.toThrow("AI Gateway timeout");
    });
  });

  describe("dedup pass A (naturalKey found)", () => {
    it("returns updated_principal action when pass A finds an existing node", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi
            .fn()
            .mockResolvedValue([
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
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });
      expect(result).toMatchObject({ action: "updated_principal" });
    });

    it("emits ingestion/entity.updated with previousProperties (and NOT entity.created) on an update", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi
            .fn()
            .mockResolvedValue([
              { oxagen_entity_type: "task", property_mappings: {} },
            ]),
        }),
      );
      // The upsert reports the pre-overwrite snapshot the emit forwards.
      mocks.upsertEntityNode.mockResolvedValueOnce({
        nodeId: "neo4j-existing-node",
        isNew: false,
        previousProperties: { state: "open" },
      });

      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const stepRun = vi.fn(async (name: string, fn: () => unknown) => {
        if (name === "dedup-pass-a") {
          return { found: true, nodeId: "neo4j-existing-node" };
        }
        return fn();
      });
      const step = makeStep({ run: stepRun, sendEvent });
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      const emitted = sendEvent.mock.calls[0]![1] as {
        name: string;
        data: Record<string, unknown>;
      };
      expect(emitted.name).toBe("ingestion/entity.updated");
      expect(emitted.data["isNew"]).toBe(false);
      expect(emitted.data["previousProperties"]).toEqual({ state: "open" });
    });
  });

  // ── DeliveryConfig enforcement (filters + legacy embedding opt-out) ──
  describe("DeliveryConfig enforcement", () => {
    // Mocks the step-1 JOIN read (entity_type_mappings ⨝ source_connections):
    // returns one mapping row with the connection's delivery_config attached.
    function mockRowWithConfig(
      deliveryConfig: unknown,
      mappingRow: {
        oxagen_entity_type: string;
        property_mappings: Record<string, string>;
      } = {
        oxagen_entity_type: "task",
        property_mappings: {},
      },
    ): void {
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          execute: vi
            .fn()
            .mockResolvedValue([
              { ...mappingRow, delivery_config: deliveryConfig },
            ]),
        }),
      );
    }

    function eventsFrom(
      sendEvent: ReturnType<typeof vi.fn>,
    ): Array<{ name: string; data: Record<string, unknown> }> {
      const payload = sendEvent.mock.calls[0]![1] as {
        name: string;
        data: Record<string, unknown>;
      };
      return [payload];
    }

    // ── Stage 1: record-type filter ─────────────────────────────────────────
    it("drops a record whose type is not in recordTypeFilters (Stage 1)", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mockRowWithConfig({ recordTypeFilters: ["issue"] }); // BASE_EVENT is pull_request

      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      expect(result).toEqual({
        skipped: true,
        reason: "record_type_not_allowed",
      });
      expect(mocks.upsertEntityNode).not.toHaveBeenCalled();
      expect(mocks.embedEntity).not.toHaveBeenCalled();
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("keeps a record whose type IS in recordTypeFilters", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mockRowWithConfig({ recordTypeFilters: ["pull_request", "issue"] });

      const step = makeStep();
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      expect(result).toEqual({
        naturalKey: "github:conn-abc:42",
        action: "created_principal",
      });
      expect(mocks.upsertEntityNode).toHaveBeenCalled();
    });

    // ── Stage 2: path filter ────────────────────────────────────────────────
    it("drops a record whose path matches pathFilters (Stage 2)", async () => {
      mocks.getConnector.mockReturnValue({
        normalizeRecord: () => ({
          ...NORMALIZED,
          properties: { path: "node_modules/pkg/index.ts" },
        }),
      });
      mockRowWithConfig({ pathFilters: ["node_modules/**"] });

      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      expect(result).toEqual({ skipped: true, reason: "path_filtered" });
      expect(mocks.upsertEntityNode).not.toHaveBeenCalled();
      expect(mocks.embedEntity).not.toHaveBeenCalled();
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("keeps a record whose path does not match pathFilters", async () => {
      mocks.getConnector.mockReturnValue({
        normalizeRecord: () => ({
          ...NORMALIZED,
          properties: { path: "src/index.ts" },
        }),
      });
      mockRowWithConfig({ pathFilters: ["node_modules/**"] });

      const step = makeStep();
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      expect(result).toMatchObject({ action: "created_principal" });
      expect(mocks.upsertEntityNode).toHaveBeenCalled();
    });

    // ── Stage 2: label filter ───────────────────────────────────────────────
    it("drops a record whose label matches labelFilters (Stage 2)", async () => {
      mocks.getConnector.mockReturnValue({
        normalizeRecord: () => ({
          ...NORMALIZED,
          properties: { labels: [{ name: "wontfix" }] },
        }),
      });
      mockRowWithConfig({ labelFilters: ["wontfix"] });

      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      expect(result).toEqual({ skipped: true, reason: "label_filtered" });
      expect(mocks.upsertEntityNode).not.toHaveBeenCalled();
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("keeps a record whose labels do not match labelFilters", async () => {
      mocks.getConnector.mockReturnValue({
        normalizeRecord: () => ({
          ...NORMALIZED,
          properties: { labels: ["bug", "p1"] },
        }),
      });
      mockRowWithConfig({ labelFilters: ["wontfix"] });

      const step = makeStep();
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      expect(result).toMatchObject({ action: "created_principal" });
      expect(mocks.upsertEntityNode).toHaveBeenCalled();
    });

    // ── Stage 5: legacy embedding opt-out ──────────────────────────────────
    it("skips embed when semanticInference.enabled is false", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mockRowWithConfig({ semanticInference: { enabled: false } });

      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      // Node is still written; only embedding is skipped.
      expect(result).toEqual({
        naturalKey: "github:conn-abc:42",
        action: "created_principal",
      });
      expect(mocks.upsertEntityNode).toHaveBeenCalled();
      expect(mocks.embedEntity).not.toHaveBeenCalled();

      const events = eventsFrom(sendEvent);
      expect(events).toHaveLength(1);
      expect(events[0]!.name).toBe("ingestion/entity.created");
    });

    it("skips embedding when perRecordType disables this record type", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mockRowWithConfig({
        semanticInference: {
          enabled: true,
          perRecordType: { pull_request: false },
        },
      });

      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(mocks.embedEntity).not.toHaveBeenCalled();
      const events = eventsFrom(sendEvent);
      expect(events).toHaveLength(1);
      expect(events[0]!.name).toBe("ingestion/entity.created");
    });

    it("runs embed without scheduling relationship inference when the legacy flag is true", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mockRowWithConfig({ semanticInference: { enabled: true } });

      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      await capturedHandler!({ event: { data: BASE_EVENT }, step });

      expect(mocks.embedEntity).toHaveBeenCalled();
      const events = eventsFrom(sendEvent);
      expect(events).toHaveLength(1);
      expect(events[0]!.name).toBe("ingestion/entity.created");
    });

    // ── Backward compatibility: unset / empty DeliveryConfig ────────────────
    it("applies no filtering and embeds when delivery_config is null", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mockRowWithConfig(null);

      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const step = makeStep({ sendEvent });
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      expect(result).toEqual({
        naturalKey: "github:conn-abc:42",
        action: "created_principal",
      });
      expect(mocks.embedEntity).toHaveBeenCalled();
      expect(eventsFrom(sendEvent)).toHaveLength(1);
    });

    it("applies no filtering when every filter array is empty", async () => {
      mocks.getConnector.mockReturnValue({ normalizeRecord: () => NORMALIZED });
      mockRowWithConfig({
        recordTypeFilters: [],
        pathFilters: [],
        labelFilters: [],
      });

      const step = makeStep();
      const result = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });

      expect(result).toMatchObject({ action: "created_principal" });
      expect(mocks.upsertEntityNode).toHaveBeenCalled();
    });
  });
});
