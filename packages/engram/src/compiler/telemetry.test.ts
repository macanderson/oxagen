/**
 * Tests for compiler/telemetry.ts — emitCompileTelemetry, setCompileTelemetrySink.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  emitCompileTelemetry,
  setCompileTelemetrySink,
  clearCompileTelemetrySinkForTests,
  type CompileTelemetryEvent,
  type TelemetrySink,
} from "./telemetry";
import type { ContextWindow } from "./layout";
import type { TaskFrame } from "../retrieval/types";

const taskFrame: TaskFrame = {
  namespace: { org: "test-org", workspace: "test-ws" },
  taskDescription: "Fix the bug",
  workingSet: [],
  recentEventIds: [],
  modelId: "claude-3-5-sonnet",
  sessionId: "session-abc",
  agentId: "agent-xyz",
};

const contextWindow: ContextWindow = {
  sections: [],
  tokenUsage: {
    system: 100,
    procedural: 50,
    volatile: 500,
    working: 200,
    total: 850,
    budgetRemaining: 9150,
  },
  cachePrefix: {
    stableBytes: 3000,
    totalBytes: 7000,
    hitRate: 0.43,
  },
  metadata: {
    compiledAt: Date.now(),
    retrievalMs: 15,
    packingMs: 5,
    layoutMs: 2,
    totalMs: 22,
    candidatesRetrieved: 25,
    candidatesPacked: 10,
    candidatesCompressed: 3,
    candidatesEvicted: 12,
    retrievalFailures: 0,
    pinnedTruncated: 0,
    contentTruncated: 0,
  },
};

describe("emitCompileTelemetry", () => {
  beforeEach(() => {
    clearCompileTelemetrySinkForTests();
  });

  it("does nothing when no sink is configured", async () => {
    // Should not throw even with no sink
    await expect(
      emitCompileTelemetry(taskFrame, contextWindow),
    ).resolves.toBeUndefined();
  });

  it("calls the sink with correct event fields when configured", async () => {
    const events: CompileTelemetryEvent[] = [];
    const sink: TelemetrySink = vi.fn(
      async (event: CompileTelemetryEvent): Promise<void> => {
        events.push(event);
      },
    );

    setCompileTelemetrySink(sink);
    await emitCompileTelemetry(taskFrame, contextWindow);

    expect(sink).toHaveBeenCalledOnce();
    const event = events[0]!;
    expect(event.org_id).toBe("test-org");
    expect(event.workspace_id).toBe("test-ws");
    expect(event.session_id).toBe("session-abc");
    expect(event.agent_id).toBe("agent-xyz");
    expect(event.model_id).toBe("claude-3-5-sonnet");
    expect(event.retrieval_ms).toBe(15);
    expect(event.packing_ms).toBe(5);
    expect(event.layout_ms).toBe(2);
    expect(event.total_ms).toBe(22);
    expect(event.candidates_retrieved).toBe(25);
    expect(event.candidates_packed).toBe(10);
    expect(event.candidates_compressed).toBe(3);
    expect(event.candidates_evicted).toBe(12);
    expect(event.budget_used).toBe(850);
    expect(event.budget_remaining).toBe(9150);
    expect(event.cache_stable_bytes).toBe(3000);
    expect(event.cache_total_bytes).toBe(7000);
    expect(event.cache_hit_rate).toBeCloseTo(0.43, 2);
  });

  it("computes budget_total as budget_used + budget_remaining", async () => {
    const events: CompileTelemetryEvent[] = [];
    const sink: TelemetrySink = vi.fn(
      async (event: CompileTelemetryEvent): Promise<void> => {
        events.push(event);
      },
    );

    setCompileTelemetrySink(sink);
    await emitCompileTelemetry(taskFrame, contextWindow);

    const event = events[0]!;
    expect(event.budget_total).toBe(event.budget_used + event.budget_remaining);
  });

  it("includes a compile_id UUID", async () => {
    const events: CompileTelemetryEvent[] = [];
    const sink: TelemetrySink = vi.fn(
      async (event: CompileTelemetryEvent): Promise<void> => {
        events.push(event);
      },
    );

    setCompileTelemetrySink(sink);
    await emitCompileTelemetry(taskFrame, contextWindow);

    const event = events[0]!;
    expect(event.compile_id).toBeTruthy();
    expect(typeof event.compile_id).toBe("string");
  });

  it("includes created_at ISO timestamp", async () => {
    const events: CompileTelemetryEvent[] = [];
    const sink: TelemetrySink = vi.fn(
      async (event: CompileTelemetryEvent): Promise<void> => {
        events.push(event);
      },
    );

    setCompileTelemetrySink(sink);
    await emitCompileTelemetry(taskFrame, contextWindow);

    const event = events[0]!;
    expect(() => new Date(event.created_at)).not.toThrow();
    expect(new Date(event.created_at).getFullYear()).toBeGreaterThanOrEqual(
      2026,
    );
  });

  it("uses null for session_id when not provided", async () => {
    const frameWithoutSession: TaskFrame = {
      ...taskFrame,
      sessionId: undefined,
      agentId: undefined,
    };
    const events: CompileTelemetryEvent[] = [];
    const sink: TelemetrySink = vi.fn(
      async (event: CompileTelemetryEvent): Promise<void> => {
        events.push(event);
      },
    );

    setCompileTelemetrySink(sink);
    await emitCompileTelemetry(frameWithoutSession, contextWindow);

    const event = events[0]!;
    expect(event.session_id).toBeNull();
    expect(event.agent_id).toBeNull();
  });

  it("swallows errors from the sink (best-effort)", async () => {
    const sink: TelemetrySink = vi.fn(async (): Promise<void> => {
      throw new Error("ClickHouse is down");
    });

    setCompileTelemetrySink(sink);
    // Should not throw
    await expect(
      emitCompileTelemetry(taskFrame, contextWindow),
    ).resolves.toBeUndefined();
  });

  it("stops emitting after clearCompileTelemetrySinkForTests()", async () => {
    const sink: TelemetrySink = vi.fn(async (): Promise<void> => undefined);
    setCompileTelemetrySink(sink);
    clearCompileTelemetrySinkForTests();

    await emitCompileTelemetry(taskFrame, contextWindow);

    expect(sink).not.toHaveBeenCalled();
  });
});
