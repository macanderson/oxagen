import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies before importing the module under test.
vi.mock("@oxagen/ontology", () => ({
  recordExecutionInGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/database", () => ({
  withTenantDb: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
    }),
  ),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn().mockImplementation((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { recordExecutionInGraph } from "@oxagen/ontology";
import { withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { agentSyncExecutionToGraph } from "./agent.sync-execution-to-graph";

const mockRecordExecution = vi.mocked(recordExecutionInGraph);
const mockWithTenantDb = vi.mocked(withTenantDb);
const mockRunInTenantScope = vi.mocked(runInTenantScope);

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
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      expect(mockRecordExecution).toHaveBeenCalledWith(EXEC_PAYLOAD);
    });

    it("passes toolCalls array to recordExecutionInGraph", async () => {
      const mockStep = {
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      const call = mockRecordExecution.mock.calls[0]![0];
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
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: minimalPayload },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      expect(mockRecordExecution).toHaveBeenCalledWith(minimalPayload);
    });
  });

  describe("stamp-synced-at step", () => {
    it("calls withTenantDb to update synced_to_graph_at via step.run", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ rowCount: 1 });
      mockWithTenantDb.mockImplementation((fn) =>
        fn({ execute: mockExecute } as unknown as Parameters<typeof fn>[0]),
      );

      const mockStep = {
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      // Verify step.run was called for both "write-neo4j" and "stamp-synced-at"
      expect(mockStep.run).toHaveBeenCalledTimes(2);
      expect(mockStep.run).toHaveBeenNthCalledWith(2, "stamp-synced-at", expect.any(Function));
      expect(mockWithTenantDb).toHaveBeenCalled();
    });
  });

  describe("tenant scope isolation", () => {
    it("runs Neo4j write inside runInTenantScope with correct orgId/workspaceId", async () => {
      const mockStep = {
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      expect(mockRunInTenantScope).toHaveBeenCalledWith(
        { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
        expect.any(Function),
      );
    });

    it("isolates org_a from org_b", async () => {
      const orgAPayload = { ...EXEC_PAYLOAD, orgId: "org-a", workspaceId: "ws-a" };
      const orgBPayload = { ...EXEC_PAYLOAD, orgId: "org-b", workspaceId: "ws-b", executionId: "aex-b" };

      const mockStep = {
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: orgAPayload },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      mockStep.run.mockClear();
      mockRunInTenantScope.mockClear();

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: orgBPayload },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      expect(mockRecordExecution).toHaveBeenCalledTimes(2);
      const [call1, call2] = mockRecordExecution.mock.calls;
      expect(call1![0].orgId).toBe("org-a");
      expect(call2![0].orgId).toBe("org-b");
    });
  });

  describe("idempotency", () => {
    it("can be called multiple times with same executionId without error", async () => {
      const mockStep = {
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      await agentSyncExecutionToGraph.fn(
        {
          event: { data: EXEC_PAYLOAD },
          step: mockStep,
        } as any,
        undefined,
        undefined,
      );

      expect(mockRecordExecution).toHaveBeenCalledTimes(2);
      // Both calls identical — MERGE in Neo4j handles idempotency
    });
  });

  describe("error handling", () => {
    it("propagates Neo4j errors so Inngest can retry", async () => {
      mockRecordExecution.mockRejectedValueOnce(new Error("Neo4j connection refused"));

      const mockStep = {
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await expect(
        agentSyncExecutionToGraph.fn(
          {
            event: { data: EXEC_PAYLOAD },
            step: mockStep,
          } as any,
          undefined,
          undefined,
        ),
      ).rejects.toThrow("Neo4j connection refused");
    });

    it("propagates DB errors on stamp step so Inngest can retry", async () => {
      const mockExecute = vi.fn().mockRejectedValueOnce(new Error("DB connection lost"));
      mockWithTenantDb.mockImplementation((fn) =>
        fn({ execute: mockExecute } as unknown as Parameters<typeof fn>[0]),
      );

      const mockStep = {
        run: vi.fn((name: string, fn: () => unknown) => fn()),
      };

      await expect(
        agentSyncExecutionToGraph.fn(
          {
            event: { data: EXEC_PAYLOAD },
            step: mockStep,
          } as any,
          undefined,
          undefined,
        ),
      ).rejects.toThrow("DB connection lost");
    });
  });
});
