import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — factory must not reference variables declared after it.
vi.mock("../tenant", () => ({
  scopedSession: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { scopedSession } from "../tenant";
import { recordExecutionInGraph, type RecordExecutionInput } from "./record-execution";

const mockScopedSession = vi.mocked(scopedSession);

const BASE_INPUT: RecordExecutionInput = {
  executionId: "aex-unit-001",
  orgId: "org-test",
  workspaceId: "ws-test",
  status: "completed",
  originType: "chat",
  originId: "conv-origin-001",
  agentId: "agt-001",
  startedAt: "2026-06-08T09:00:00Z",
  completedAt: "2026-06-08T09:00:10Z",
  latencyMs: 10000,
  inputTokens: 800,
  outputTokens: 200,
  estimatedCostUsd: "0.003200",
  toolCalls: [{ toolName: "web.search", toolType: "builtin" }],
};

describe("recordExecutionInGraph", () => {
  let mockNeoRun: ReturnType<typeof vi.fn>;
  let mockNeoClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNeoRun = vi.fn().mockResolvedValue({ records: [] });
    mockNeoClose = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run: mockNeoRun, close: mockNeoClose });
  });

  it("runs a MERGE Cypher for the Execution node", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const firstCall = mockNeoRun.mock.calls[0];
    expect(firstCall).toBeDefined();
    const cypher = firstCall![0] as string;
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Execution");
    expect(cypher).toContain("$executionId");
  });

  it("creates INVOKED edge to Agent node when agentId is provided", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const agentCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes(":Agent"),
    );
    expect(agentCall).toBeDefined();
    expect(agentCall![0]).toContain("INVOKED");
  });

  it("skips Agent edge when agentId is null", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, agentId: null });

    const agentCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes(":Agent"),
    );
    expect(agentCall).toBeUndefined();
  });

  it("creates ORIGINATED_FROM edge to Conversation for chat origin", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, originType: "chat" });

    const originCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("ORIGINATED_FROM"),
    );
    expect(originCall).toBeDefined();
    expect(originCall![0]).toContain(":Conversation");
  });

  it("creates ORIGINATED_FROM edge to WorkflowRun for workflow_run origin", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, originType: "workflow_run" });

    const originCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("ORIGINATED_FROM"),
    );
    expect(originCall).toBeDefined();
    expect(originCall![0]).toContain(":WorkflowRun");
  });

  it("skips ORIGINATED_FROM edge for unknown originType", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, originType: "scheduled_job" });

    const originCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("ORIGINATED_FROM"),
    );
    expect(originCall).toBeUndefined();
  });

  it("creates CALLED_TOOL edges for all toolCalls in a single UNWIND query", async () => {
    const toolCalls = [
      { toolName: "web.search", toolType: "builtin" },
      { toolName: "document.create", toolType: "capability" },
    ];
    await recordExecutionInGraph({ ...BASE_INPUT, toolCalls });

    const toolCallCyphers = mockNeoRun.mock.calls.filter(([cypher]) =>
      (cypher as string).includes("CALLED_TOOL"),
    );
    // UNWIND collapses all tool-call MERGEs into one round-trip (no N+1).
    expect(toolCallCyphers).toHaveLength(1);
    expect(toolCallCyphers[0]![0]).toContain("UNWIND");
    const params = toolCallCyphers[0]![1] as Record<string, unknown>;
    expect(params.toolCalls).toEqual(toolCalls);
  });

  it("skips CALLED_TOOL edges when toolCalls is empty", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, toolCalls: [] });

    const toolCallCyphers = mockNeoRun.mock.calls.filter(([cypher]) =>
      (cypher as string).includes("CALLED_TOOL"),
    );
    expect(toolCallCyphers).toHaveLength(0);
  });

  it("always calls close() even if run() throws", async () => {
    mockNeoRun.mockRejectedValueOnce(new Error("Neo4j unreachable"));

    await expect(recordExecutionInGraph(BASE_INPUT)).rejects.toThrow("Neo4j unreachable");
    expect(mockNeoClose).toHaveBeenCalledOnce();
  });

  it("passes status, latency, and token fields to the MERGE params", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const mergeCall = mockNeoRun.mock.calls[0];
    const params = mergeCall![1] as Record<string, unknown>;
    expect(params.status).toBe("completed");
    expect(params.latencyMs).toBe(10000);
    expect(params.inputTokens).toBe(800);
    expect(params.outputTokens).toBe(200);
  });

  it("is idempotent — two calls with same executionId both succeed", async () => {
    await recordExecutionInGraph(BASE_INPUT);
    await recordExecutionInGraph(BASE_INPUT);

    // Each call should run at minimum the Execution MERGE per invocation.
    expect(mockNeoRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
