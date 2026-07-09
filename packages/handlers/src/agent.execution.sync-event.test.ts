/**
 * Unit tests for emitExecutionSyncEvent.
 *
 * Covers:
 *  - Fires agent/execution.sync on terminal status with mapped fields + tool calls.
 *  - Skips non-terminal status (planning/running) — no event.
 *  - Date → ISO string and number → string conversions match the event schema.
 *  - Best-effort: a send failure is swallowed (logged), never thrown.
 *  - Embedding, summary, and displayName are computed and included in the event.
 *  - A failed embedText call is swallowed; event is still emitted with embedding: null.
 *  - executionStepId forwarded to embedText is null (not a synthesized string).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_EMBEDDING = new Array(1536).fill(0.42);

const { mockSend, mockEmbedText } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockEmbedText: vi.fn(),
}));

vi.mock("./event-client", () => ({
  eventClient: { send: mockSend },
}));

vi.mock("@oxagen/ai", () => ({
  embedText: mockEmbedText,
}));

import { emitExecutionSyncEvent } from "./agent.execution.sync-event";

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  mockEmbedText.mockResolvedValue(FAKE_EMBEDDING);
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
        { toolCalls: [{ toolName: "search_web", toolType: "capability" }] },
        { toolCalls: [{ toolName: "ingest_graph", toolType: "capability" }] },
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
      { toolName: "search_web", toolType: "capability" },
      { toolName: "ingest_graph", toolType: "capability" },
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

  it("does not call embedText for non-terminal status", async () => {
    await emitExecutionSyncEvent({ ...base, status: "running" });
    expect(mockEmbedText).not.toHaveBeenCalled();
  });
});

describe("emitExecutionSyncEvent — best-effort (send)", () => {
  it("swallows a send failure instead of throwing", async () => {
    mockSend.mockRejectedValueOnce(new Error("inngest unavailable"));
    await expect(
      emitExecutionSyncEvent({ ...base, status: "completed" }),
    ).resolves.toBeUndefined();
  });
});

// ── Embedding ─────────────────────────────────────────────────────────────────

describe("emitExecutionSyncEvent — embedding", () => {
  it("calls embedText with the summary text and graph surface telemetry", async () => {
    await emitExecutionSyncEvent({
      ...base,
      status: "completed",
      agentId: "agt-5",
      outputTokens: 100,
      steps: [{ toolCalls: [{ toolName: "search_web", toolType: "builtin" }] }],
    });

    expect(mockEmbedText).toHaveBeenCalledOnce();
    const [text, opts] = mockEmbedText.mock.calls[0]! as [
      string,
      { telemetry: { orgId: string; workspaceId: string; surface: string; executionStepId: string | null } },
    ];
    // Summary text must describe the execution meaningfully
    expect(text).toContain("chat");
    expect(text).toContain("completed");
    expect(text).toContain("search_web");
    // Telemetry shape must match EmbedTextOpts
    expect(opts.telemetry.orgId).toBe("org-1");
    expect(opts.telemetry.workspaceId).toBe("ws-1");
    expect(opts.telemetry.surface).toBe("runner");
    // executionStepId MUST be null — a synthesized string breaks ClickHouse UUID column
    expect(opts.telemetry.executionStepId).toBeNull();
  });

  it("includes the computed embedding in the event payload", async () => {
    await emitExecutionSyncEvent({ ...base, status: "completed" });

    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(payload.data.embedding).toEqual(FAKE_EMBEDDING);
  });

  it("swallows embedText failure and emits event with embedding: null", async () => {
    mockEmbedText.mockRejectedValueOnce(new Error("AI gateway timeout"));

    await expect(emitExecutionSyncEvent({ ...base, status: "completed" })).resolves.toBeUndefined();

    // Event must still be emitted
    expect(mockSend).toHaveBeenCalledOnce();
    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(payload.data.embedding).toBeNull();
  });

  it("still emits the event when embedText fails (lineage is not blocked by embedding)", async () => {
    mockEmbedText.mockRejectedValueOnce(new Error("network error"));
    await emitExecutionSyncEvent({ ...base, status: "completed" });
    expect(mockSend).toHaveBeenCalledOnce();
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────

describe("emitExecutionSyncEvent — summary", () => {
  it("includes a summary string in the event payload", async () => {
    await emitExecutionSyncEvent({
      ...base,
      status: "completed",
      agentId: "agt-5",
      outputTokens: 200,
      steps: [{ toolCalls: [{ toolName: "search_web", toolType: "builtin" }] }],
    });

    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(typeof payload.data.summary).toBe("string");
    const summary = payload.data.summary as string;
    expect(summary).toContain("chat");
    expect(summary).toContain("completed");
    expect(summary).toContain("agt-5");
    expect(summary).toContain("search_web");
    expect(summary).toContain("200");
  });

  it("summary says 'no tool calls' when there are none", async () => {
    await emitExecutionSyncEvent({ ...base, status: "completed", steps: [] });

    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(payload.data.summary as string).toContain("no tool calls");
  });

  it("summary omits agent clause when agentId is absent", async () => {
    await emitExecutionSyncEvent({ ...base, status: "completed" });

    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    const summary = payload.data.summary as string;
    expect(summary).not.toContain("by agent");
  });
});

// ── displayName ───────────────────────────────────────────────────────────────

describe("emitExecutionSyncEvent — displayName", () => {
  it("includes a displayName string in the event payload", async () => {
    await emitExecutionSyncEvent({ ...base, status: "completed", agentId: "agt-7" });

    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(typeof payload.data.displayName).toBe("string");
    const displayName = payload.data.displayName as string;
    // Must be human-readable: contain originType, never a raw UUID
    expect(displayName).toContain("chat");
    expect(displayName).toContain("agt-7");
    // Raw UUID check: executionId is "exec-1" which is not a UUID, so just verify
    // it contains meaningful words rather than an opaque hash
    expect(displayName.length).toBeGreaterThan(4);
  });

  it("displayName is set without an agent suffix when agentId is absent", async () => {
    await emitExecutionSyncEvent({ ...base, status: "completed" });

    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    const displayName = payload.data.displayName as string;
    expect(displayName).toContain("chat");
    expect(displayName).not.toContain("by");
  });

  it("displayName uses originType for workflow_run executions", async () => {
    await emitExecutionSyncEvent({ ...base, status: "completed", originType: "workflow_run" });

    const payload = mockSend.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(payload.data.displayName as string).toContain("workflow_run");
  });
});
