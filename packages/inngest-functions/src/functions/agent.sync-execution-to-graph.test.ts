import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the handler at module-load time by mocking inngest.createFunction.
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  recordExecutionInGraph: vi.fn().mockResolvedValue(undefined),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  loggerInfo: vi.fn(),
}));

type InngestContext = {
  event: { data: unknown };
  step: { run: (name: string, fn: () => unknown) => unknown };
};

let capturedHandler: ((ctx: InngestContext) => unknown) | null = null;

mocks.createFunction.mockImplementation((_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
  capturedHandler = handler;
  return {};
});

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.createFunction },
}));

vi.mock("@oxagen/ontology", () => ({
  recordExecutionInGraph: mocks.recordExecutionInGraph,
}));

vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
    }),
  ),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, error: vi.fn(), warn: vi.fn() },
}));

// Import module to trigger createFunction call.
await import("./agent.sync-execution-to-graph");

const EXEC_PAYLOAD = {
  executionId: "aex-test-123",
  orgId: "org-abc",
  workspaceId: "ws-xyz",
  status: "completed",
  originType: "chat",
  originId: "msg-origin-456",
  agentId: "agt-789",
  startedAt: "2026-06-08T10:00:00Z",
  completedAt: "2026-06-08T10:00:12Z",
  latencyMs: 12000,
  inputTokens: 1240,
  outputTokens: 340,
  estimatedCostUsd: "0.005200",
  toolCalls: [
    { toolName: "web.search", toolType: "builtin" },
    { toolName: "document.read", toolType: "capability" },
  ],
};

describe("agent.sync-execution-to-graph Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("recordExecutionInGraph integration", () => {
    it("calls recordExecutionInGraph with full payload", async () => {
      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await capturedHandler!(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as InngestContext,
      );

      expect(mocks.recordExecutionInGraph).toHaveBeenCalledWith(EXEC_PAYLOAD);
    });

    it("passes toolCalls array to recordExecutionInGraph", async () => {
      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await capturedHandler!(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as InngestContext,
      );

      const call = mocks.recordExecutionInGraph.mock.calls[0]![0];
      expect(call.toolCalls).toHaveLength(2);
      expect(call.toolCalls![0]).toEqual({ toolName: "web.search", toolType: "builtin" });
    });

    it("works when optional fields are omitted", async () => {
      const minimalPayload = {
        executionId: "aex-minimal",
        orgId: "org-abc",
        workspaceId: "ws-xyz",
        status: "running",
        originType: "mcp_request",
        originId: "req-111",
      };

      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await capturedHandler!(
        {
          event: { data: minimalPayload },
          step: mockStep,
        } as InngestContext,
      );

      expect(mocks.recordExecutionInGraph).toHaveBeenCalledWith(minimalPayload);
    });
  });

  describe("stamp-synced-at step", () => {
    it("calls withTenantDb to update synced_to_graph_at via step.run", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ rowCount: 1 });
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({ execute: mockExecute }),
      );

      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await capturedHandler!(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as InngestContext,
      );

      // Verify step.run was called for both "write-neo4j" and "stamp-synced-at"
      expect(mockStep.run).toHaveBeenCalledTimes(2);
      expect(mockStep.run).toHaveBeenNthCalledWith(2, "stamp-synced-at", expect.any(Function));
      expect(mocks.withTenantDb).toHaveBeenCalled();
    });
  });

  describe("tenant scope isolation", () => {
    it("runs Neo4j write inside runInTenantScope with correct orgId/workspaceId", async () => {
      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await capturedHandler!(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as InngestContext,
      );

      expect(mocks.runInTenantScope).toHaveBeenCalledWith(
        { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
        expect.any(Function),
      );
    });

    it("isolates org_a from org_b", async () => {
      const orgAPayload = { ...EXEC_PAYLOAD, orgId: "org-a", workspaceId: "ws-a" };
      const orgBPayload = { ...EXEC_PAYLOAD, orgId: "org-b", workspaceId: "ws-b", executionId: "aex-b" };

      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await capturedHandler!(
        {
          event: { data: orgAPayload },
          step: mockStep,
        } as InngestContext,
      );

      mockStep.run.mockClear();
      mocks.runInTenantScope.mockClear();

      await capturedHandler!(
        {
          event: { data: orgBPayload },
          step: mockStep,
        } as InngestContext,
      );

      expect(mocks.recordExecutionInGraph).toHaveBeenCalledTimes(2);
      const [call1, call2] = mocks.recordExecutionInGraph.mock.calls;
      expect(call1![0].orgId).toBe("org-a");
      expect(call2![0].orgId).toBe("org-b");
    });
  });

  describe("idempotency", () => {
    it("can be called multiple times with same executionId without error", async () => {
      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await capturedHandler!(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as InngestContext,
      );

      await capturedHandler!(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as InngestContext,
      );

      expect(mocks.recordExecutionInGraph).toHaveBeenCalledTimes(2);
      // Both calls identical — MERGE in Neo4j handles idempotency
    });
  });

  describe("error handling", () => {
    it("propagates Neo4j errors so Inngest can retry", async () => {
      mocks.recordExecutionInGraph.mockRejectedValueOnce(new Error("Neo4j connection refused"));

      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await expect(
        capturedHandler!(
          {
            event: { data: EXEC_PAYLOAD },
            step: mockStep,
          } as InngestContext,
        ),
      ).rejects.toThrow("Neo4j connection refused");
    });

    it("propagates DB errors on stamp step so Inngest can retry", async () => {
      const mockExecute = vi.fn().mockRejectedValueOnce(new Error("DB connection lost"));
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({ execute: mockExecute }),
      );

      const mockStep = {
        run: vi.fn((_name: string, fn: () => unknown) => fn()),
      };

      await expect(
        capturedHandler!(
          {
            event: { data: EXEC_PAYLOAD },
            step: mockStep,
          } as InngestContext,
        ),
      ).rejects.toThrow("DB connection lost");
    });
  });
});
