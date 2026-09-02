/**
 * Tests for session/replay.ts — analyzeReplay and extractTurnMetrics.
 */
import { describe, it, expect } from "vitest";
import { analyzeReplay, extractTurnMetrics } from "./replay";
import type { Session, SessionEvent } from "./types";
import type { Namespace } from "../types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };

function makeSession(
  events: SessionEvent[],
  overrides: Partial<Session> = {},
): Session {
  return {
    id: "session-1",
    namespace: NS,
    events,
    createdAt: Date.now(),
    status: "completed",
    ...overrides,
  };
}

function makeEvent(
  index: number,
  type: SessionEvent["type"],
  turnId: string | null,
  data: unknown,
): SessionEvent {
  return { index, type, turnId, data, timestamp: Date.now() };
}

describe("analyzeReplay", () => {
  it("returns correct sessionId", () => {
    const session = makeSession([], { id: "sess-abc" });
    const result = analyzeReplay(session);
    expect(result.sessionId).toBe("sess-abc");
  });

  it("counts total events", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "session_start", null, {}),
      makeEvent(1, "turn_start", "t1", {}),
      makeEvent(2, "session_end", null, {}),
    ];
    const result = analyzeReplay(makeSession(events));
    expect(result.totalEvents).toBe(3);
  });

  it("counts only context_compiled events as stepsReplayed", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "session_start", null, {}),
      makeEvent(1, "turn_start", "t1", {}),
      makeEvent(2, "context_compiled", "t1", {
        candidatesRetrieved: 10,
        candidatesPacked: 5,
        candidatesEvicted: 5,
        totalTokens: 1000,
        cacheHitRate: 0.6,
        compileMs: 20,
      }),
      makeEvent(3, "turn_end", "t1", { outcome: "success" }),
    ];
    const result = analyzeReplay(makeSession(events));
    expect(result.stepsReplayed).toBe(1);
  });

  it("returns deterministic: true when all metrics are valid", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "context_compiled", "t1", {
        candidatesRetrieved: 10,
        candidatesPacked: 5,
        candidatesEvicted: 5,
        totalTokens: 1000,
        cacheHitRate: 0.8,
        compileMs: 15,
      }),
    ];
    const result = analyzeReplay(makeSession(events));
    expect(result.deterministic).toBe(true);
    expect(result.divergences).toHaveLength(0);
  });

  it("detects divergence when totalTokens is negative", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "context_compiled", "t1", {
        candidatesRetrieved: 5,
        candidatesPacked: 3,
        candidatesEvicted: 2,
        totalTokens: -1, // invalid
        cacheHitRate: 0.5,
        compileMs: 10,
      }),
    ];
    const result = analyzeReplay(makeSession(events));
    expect(result.deterministic).toBe(false);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]!.matches).toBe(false);
    expect(result.divergences[0]!.divergence).toContain("tokens=-1");
  });

  it("detects divergence when cacheHitRate > 1", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "context_compiled", "t1", {
        candidatesRetrieved: 5,
        candidatesPacked: 3,
        candidatesEvicted: 2,
        totalTokens: 500,
        cacheHitRate: 1.5, // invalid
        compileMs: 10,
      }),
    ];
    const result = analyzeReplay(makeSession(events));
    expect(result.deterministic).toBe(false);
    expect(result.divergences).toHaveLength(1);
  });

  it("detects divergence when cacheHitRate < 0", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "context_compiled", "t1", {
        candidatesRetrieved: 5,
        candidatesPacked: 3,
        candidatesEvicted: 2,
        totalTokens: 500,
        cacheHitRate: -0.1, // invalid
        compileMs: 10,
      }),
    ];
    const result = analyzeReplay(makeSession(events));
    expect(result.deterministic).toBe(false);
  });

  it("handles empty event log", () => {
    const result = analyzeReplay(makeSession([]));
    expect(result.stepsReplayed).toBe(0);
    expect(result.deterministic).toBe(true);
    expect(result.divergences).toHaveLength(0);
  });

  it("handles session with no context_compiled events", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "session_start", null, {}),
      makeEvent(1, "turn_start", "t1", {}),
    ];
    const result = analyzeReplay(makeSession(events));
    expect(result.stepsReplayed).toBe(0);
    expect(result.deterministic).toBe(true);
  });
});

describe("extractTurnMetrics", () => {
  it("returns empty array for session with no turns", () => {
    const result = extractTurnMetrics(makeSession([]));
    expect(result).toHaveLength(0);
  });

  it("extracts metrics for a complete turn", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "turn_start", "t1", {}),
      makeEvent(1, "context_compiled", "t1", {
        candidatesRetrieved: 10,
        candidatesPacked: 5,
        candidatesEvicted: 5,
        totalTokens: 1200,
        cacheHitRate: 0.75,
        compileMs: 30,
      }),
      makeEvent(2, "tool_call", "t1", { tool: "grep", input: {} }),
      makeEvent(3, "tool_result", "t1", {
        tool: "grep",
        success: true,
        outputTokens: 50,
      }),
      makeEvent(4, "turn_end", "t1", {
        outcome: "success",
        totalTokens: 1250,
        durationMs: 500,
      }),
    ];

    const result = extractTurnMetrics(makeSession(events));

    expect(result).toHaveLength(1);
    expect(result[0]!.turnId).toBe("t1");
    expect(result[0]!.compileMs).toBe(30);
    expect(result[0]!.tokens).toBe(1200);
    expect(result[0]!.cacheHitRate).toBe(0.75);
    expect(result[0]!.toolCalls).toBe(1);
    expect(result[0]!.outcome).toBe("success");
  });

  it("extracts metrics for multiple turns", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "turn_start", "t1", {}),
      makeEvent(1, "context_compiled", "t1", {
        candidatesRetrieved: 5,
        candidatesPacked: 3,
        candidatesEvicted: 2,
        totalTokens: 800,
        cacheHitRate: 0.6,
        compileMs: 15,
      }),
      makeEvent(2, "turn_end", "t1", {
        outcome: "success",
        totalTokens: 800,
        durationMs: 200,
      }),
      makeEvent(3, "turn_start", "t2", {}),
      makeEvent(4, "context_compiled", "t2", {
        candidatesRetrieved: 8,
        candidatesPacked: 4,
        candidatesEvicted: 4,
        totalTokens: 950,
        cacheHitRate: 0.7,
        compileMs: 20,
      }),
      makeEvent(5, "tool_call", "t2", { tool: "bash", input: {} }),
      makeEvent(6, "tool_call", "t2", { tool: "read", input: {} }),
      makeEvent(7, "turn_end", "t2", {
        outcome: "failure",
        totalTokens: 1050,
        durationMs: 300,
      }),
    ];

    const result = extractTurnMetrics(makeSession(events));

    expect(result).toHaveLength(2);
    expect(result[0]!.turnId).toBe("t1");
    expect(result[0]!.outcome).toBe("success");
    expect(result[1]!.turnId).toBe("t2");
    expect(result[1]!.toolCalls).toBe(2);
    expect(result[1]!.outcome).toBe("failure");
  });

  it("handles turn with no context_compiled event (defaults to 0)", () => {
    const events: SessionEvent[] = [
      makeEvent(0, "turn_start", "t1", {}),
      makeEvent(1, "turn_end", "t1", {
        outcome: "success",
        totalTokens: 0,
        durationMs: 0,
      }),
    ];

    const result = extractTurnMetrics(makeSession(events));

    expect(result).toHaveLength(1);
    expect(result[0]!.compileMs).toBe(0);
    expect(result[0]!.tokens).toBe(0);
    expect(result[0]!.cacheHitRate).toBe(0);
    expect(result[0]!.toolCalls).toBe(0);
  });

  it("handles turn with no turn_end (uses 'unknown' as outcome)", () => {
    // The last turn never gets a turn_end before the session ends
    const events: SessionEvent[] = [
      makeEvent(0, "turn_start", "t1", {}),
      makeEvent(1, "context_compiled", "t1", {
        candidatesRetrieved: 5,
        candidatesPacked: 3,
        candidatesEvicted: 2,
        totalTokens: 700,
        cacheHitRate: 0.5,
        compileMs: 10,
      }),
      // No turn_end — flush happens at end of events
    ];

    const result = extractTurnMetrics(makeSession(events));

    expect(result).toHaveLength(1);
    expect(result[0]!.outcome).toBe("unknown");
  });
});
