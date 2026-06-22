/**
 * Unit tests for emitExecutionSyncEvent.
 *
 * Covers:
 *  - Fires agent/execution.sync on terminal status with mapped fields + tool calls.
 *  - Skips non-terminal status (planning/running) — no event.
 *  - Date → ISO string and number → string conversions match the event schema.
 *  - Best-effort: a send failure is swallowed (logged), never thrown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("./event-client", () => ({
  eventClient: { send: mockSend },
}));

import { emitExecutionSyncEvent } from "./agent.execution.sync-event";

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
});

const base = {
  executionId: "exec-1",
  orgId: "org-1",
  workspaceId: "ws-1",
  originType: "chat",
  originId: "msg-1",
};

describe("emitExecutionSyncEvent — terminal statuses", () => {
  it("fires agent/execution.sync with mapped fields and flattened tool calls", async () => {
    await emitExecutionSyncEvent({
      ...base,
      status: "completed",
      agentId: "agent-1",
      startedAt: new Date("2026-06-22T00:00:00.000Z"),
      completedAt: new Date("2026-06-22T00:00:05.000Z"),
      latencyMs: 5000,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.0123,
      steps: [
        { toolCalls: [{ toolName: "web.search", toolType: "capability" }] },
        { toolCalls: [{ toolName: "graph.ingest", toolType: "capability" }] },
        { toolCalls: null },
      ],
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const payload = mockSend.mock.calls[0]![0] as {
      name: string;
      data: Record<string, unknown>;
    };
    expect(payload.name).toBe("agent/execution.sync");
    expect(payload.data).toMatchObject({
      executionId: "exec-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      status: "completed",
      originType: "chat",
      originId: "msg-1",
      agentId: "agent-1",
      startedAt: "2026-06-22T00:00:00.000Z",
      completedAt: "2026-06-22T00:00:05.000Z",
      latencyMs: 5000,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: "0.0123",
    });
    expect(payload.data.toolCalls).toEqual([
      { toolName: "web.search", toolType: "capability" },
      { toolName: "graph.ingest", toolType: "capability" },
    ]);
  });

  it.each(["failed", "cancelled"])("fires for terminal status %s", async (status) => {
    await emitExecutionSyncEvent({ ...base, status });
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("defaults optional fields to null when absent", async () => {
    await emitExecutionSyncEvent({ ...base, status: "completed" });
    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(payload.data.agentId).toBeNull();
    expect(payload.data.startedAt).toBeNull();
    expect(payload.data.completedAt).toBeNull();
    expect(payload.data.estimatedCostUsd).toBeNull();
    expect(payload.data.toolCalls).toEqual([]);
  });
});

describe("emitExecutionSyncEvent — non-terminal statuses", () => {
  it.each(["planning", "running"])("does not fire for non-terminal status %s", async (status) => {
    await emitExecutionSyncEvent({ ...base, status });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("emitExecutionSyncEvent — best-effort", () => {
  it("swallows a send failure instead of throwing", async () => {
    mockSend.mockRejectedValueOnce(new Error("inngest unavailable"));
    await expect(
      emitExecutionSyncEvent({ ...base, status: "completed" }),
    ).resolves.toBeUndefined();
  });
});
