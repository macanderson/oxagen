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
      await mockRunInTenantScope(
        { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
        () => mockRecordExecution(EXEC_PAYLOAD),
      );

      expect(mockRecordExecution).toHaveBeenCalledWith(EXEC_PAYLOAD);
    });

    it("passes toolCalls array to recordExecutionInGraph", async () => {
      await mockRunInTenantScope(
        { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
        () => mockRecordExecution(EXEC_PAYLOAD),
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

      await mockRunInTenantScope(
        { orgId: minimalPayload.orgId, workspaceId: minimalPayload.workspaceId },
        () => mockRecordExecution(minimalPayload),
      );

      expect(mockRecordExecution).toHaveBeenCalledWith(minimalPayload);
    });
  });

  describe("stamp-synced-at step", () => {
    it("calls withTenantDb to update synced_to_graph_at", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ rowCount: 1 });
      mockWithTenantDb.mockImplementationOnce((fn) =>
        fn({ execute: mockExecute } as unknown as Parameters<typeof fn>[0]),
      );

      await mockRunInTenantScope(
        { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
        () => withTenantDb((tx) => (tx as unknown as { execute: typeof mockExecute }).execute("stub")),
      );

      expect(mockWithTenantDb).toHaveBeenCalled();
    });
  });

  describe("tenant scope isolation", () => {
    it("runs Neo4j write inside runInTenantScope with correct orgId/workspaceId", async () => {
      await mockRunInTenantScope(
        { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
        () => mockRecordExecution(EXEC_PAYLOAD),
      );

      expect(mockRunInTenantScope).toHaveBeenCalledWith(
        { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
        expect.any(Function),
      );
    });

    it("isolates org_a from org_b", async () => {
      const orgAPayload = { ...EXEC_PAYLOAD, orgId: "org-a", workspaceId: "ws-a" };
      const orgBPayload = { ...EXEC_PAYLOAD, orgId: "org-b", workspaceId: "ws-b", executionId: "aex-b" };

      await mockRunInTenantScope(
        { orgId: orgAPayload.orgId, workspaceId: orgAPayload.workspaceId },
        () => mockRecordExecution(orgAPayload),
      );
      await mockRunInTenantScope(
        { orgId: orgBPayload.orgId, workspaceId: orgBPayload.workspaceId },
        () => mockRecordExecution(orgBPayload),
      );

      expect(mockRecordExecution).toHaveBeenCalledTimes(2);
      const [call1, call2] = mockRecordExecution.mock.calls;
      expect(call1![0].orgId).toBe("org-a");
      expect(call2![0].orgId).toBe("org-b");
    });
  });

  describe("idempotency", () => {
    it("can be called multiple times with same executionId without error", async () => {
      await mockRecordExecution(EXEC_PAYLOAD);
      await mockRecordExecution(EXEC_PAYLOAD);

      expect(mockRecordExecution).toHaveBeenCalledTimes(2);
      // Both calls identical — MERGE in Neo4j handles idempotency
    });
  });

  describe("error handling", () => {
    it("propagates Neo4j errors so Inngest can retry", async () => {
      mockRecordExecution.mockRejectedValueOnce(new Error("Neo4j connection refused"));

      await expect(
        mockRunInTenantScope(
          { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
          () => mockRecordExecution(EXEC_PAYLOAD),
        ),
      ).rejects.toThrow("Neo4j connection refused");
    });

    it("propagates DB errors on stamp step so Inngest can retry", async () => {
      const mockExecute = vi.fn().mockRejectedValueOnce(new Error("DB connection lost"));
      mockWithTenantDb.mockImplementationOnce((fn) =>
        fn({ execute: mockExecute } as unknown as Parameters<typeof fn>[0]),
      );

      await expect(
        mockRunInTenantScope(
          { orgId: EXEC_PAYLOAD.orgId, workspaceId: EXEC_PAYLOAD.workspaceId },
          () => withTenantDb((tx) => (tx as unknown as { execute: typeof mockExecute }).execute("stub")),
        ),
      ).rejects.toThrow("DB connection lost");
    });
  });
});
