/**
 * Unit tests for the live session-metrics accumulator + event bus:
 *   - record: folds turn + session + byModel totals across multiple models
 *   - startTurn: resets turn totals only, session totals + byModel persist
 *   - snapshot: returns a deep copy — mutating it never touches bus state
 *   - subscribe/unsubscribe: fan-out, unsubscribe stops delivery, a throwing
 *     subscriber never breaks the others
 *   - throttle: rapid records coalesce within the window, a trailing timer
 *     still fires, a big burst notifies immediately, and flush() forces a
 *     synchronous settle
 *   - metricsEventFor: prices an event via the rate card, zero tokens -> zero cost
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createMetricsBus,
  metricsEventFor,
  type MetricsEvent,
  type SessionMetrics,
} from "../metrics.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Build a MetricsEvent with sane defaults, overridable per test. */
function ev(overrides: Partial<MetricsEvent> = {}): MetricsEvent {
  return {
    callId: "call-1",
    kind: "model_call",
    model: "anthropic/claude-sonnet-5",
    tokensIn: 10,
    tokensOut: 5,
    cachedTokens: 0,
    costUsd: 0.01,
    at: Date.now(),
    ...overrides,
  };
}

// ── record ────────────────────────────────────────────────────────────────────

describe("record", () => {
  it("accumulates turn + session + byModel totals across multiple models", () => {
    const bus = createMetricsBus();
    bus.record(
      ev({
        model: "anthropic/claude-sonnet-5",
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.1,
      }),
    );
    bus.record(
      ev({
        model: "openai/gpt-4o",
        tokensIn: 20,
        tokensOut: 10,
        costUsd: 0.02,
      }),
    );
    bus.record(
      ev({
        model: "anthropic/claude-sonnet-5",
        tokensIn: 30,
        tokensOut: 15,
        costUsd: 0.03,
      }),
    );

    const snap = bus.snapshot();
    expect(snap.turnTokensIn).toBe(150);
    expect(snap.turnTokensOut).toBe(75);
    expect(snap.turnCostUsd).toBeCloseTo(0.15);
    expect(snap.sessionTokensIn).toBe(150);
    expect(snap.sessionTokensOut).toBe(75);
    expect(snap.sessionCostUsd).toBeCloseTo(0.15);

    expect(snap.byModel["anthropic/claude-sonnet-5"]).toEqual({
      tokensIn: 130,
      tokensOut: 65,
      cachedTokens: 0,
      costUsd: 0.13,
    });
    expect(snap.byModel["openai/gpt-4o"]).toEqual({
      tokensIn: 20,
      tokensOut: 10,
      cachedTokens: 0,
      costUsd: 0.02,
    });
  });

  it("sums cachedTokens into turn + session + byModel, same as tokensIn/tokensOut — this is the LIVE per-step figure the dock reads, not a one-shot total", () => {
    const bus = createMetricsBus();
    // Simulates three real per-step model_call events within one turn — the
    // exact shape metered-ai.ts emits as each step's usage settles.
    bus.record(
      ev({
        model: "anthropic/claude-sonnet-5",
        tokensIn: 1000,
        tokensOut: 50,
        cachedTokens: 800,
        costUsd: 0.001,
      }),
    );
    bus.record(
      ev({
        model: "anthropic/claude-sonnet-5",
        tokensIn: 1000,
        tokensOut: 50,
        cachedTokens: 900,
        costUsd: 0.0005,
      }),
    );
    bus.record(
      ev({
        model: "anthropic/claude-sonnet-5",
        tokensIn: 500,
        tokensOut: 20,
        cachedTokens: 0,
        costUsd: 0.0015,
      }),
    );

    const snap = bus.snapshot();
    expect(snap.turnCachedTokens).toBe(1700);
    expect(snap.sessionCachedTokens).toBe(1700);
    expect(snap.byModel["anthropic/claude-sonnet-5"]!.cachedTokens).toBe(1700);
  });

  it("startTurn resets turnCachedTokens but preserves sessionCachedTokens and byModel", () => {
    const bus = createMetricsBus();
    bus.record(ev({ cachedTokens: 500 }));
    bus.startTurn();

    const snap = bus.snapshot();
    expect(snap.turnCachedTokens).toBe(0);
    expect(snap.sessionCachedTokens).toBe(500);
    expect(snap.byModel["anthropic/claude-sonnet-5"]!.cachedTokens).toBe(500);
  });
});

// ── startTurn ─────────────────────────────────────────────────────────────────

describe("startTurn", () => {
  it("resets turn totals but preserves session totals and byModel", () => {
    const bus = createMetricsBus();
    bus.record(
      ev({
        model: "anthropic/claude-sonnet-5",
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.1,
      }),
    );

    bus.startTurn();

    const snap = bus.snapshot();
    expect(snap.turnTokensIn).toBe(0);
    expect(snap.turnTokensOut).toBe(0);
    expect(snap.turnCostUsd).toBe(0);
    expect(snap.sessionTokensIn).toBe(100);
    expect(snap.sessionTokensOut).toBe(50);
    expect(snap.sessionCostUsd).toBeCloseTo(0.1);
    expect(snap.byModel["anthropic/claude-sonnet-5"]).toEqual({
      tokensIn: 100,
      tokensOut: 50,
      cachedTokens: 0,
      costUsd: 0.1,
    });
  });

  it("notifies subscribers so the status line clears the per-turn figure", () => {
    const bus = createMetricsBus();
    bus.record(ev({ tokensIn: 100, tokensOut: 50, costUsd: 0.1 }));

    const received: SessionMetrics[] = [];
    bus.subscribe((m) => received.push(m));
    bus.startTurn();

    expect(received.length).toBe(1);
    expect(received[0]!.turnTokensIn).toBe(0);
    expect(received[0]!.sessionTokensIn).toBe(100);
  });
});

// ── snapshot ──────────────────────────────────────────────────────────────────

describe("snapshot", () => {
  it("returns a deep copy that cannot mutate internal bus state", () => {
    const bus = createMetricsBus();
    bus.record(
      ev({
        model: "anthropic/claude-sonnet-5",
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.01,
      }),
    );

    const snap = bus.snapshot();
    snap.turnTokensIn = 999_999;
    snap.byModel["anthropic/claude-sonnet-5"]!.tokensIn = 999_999;
    snap.byModel["new-model"] = {
      tokensIn: 1,
      tokensOut: 1,
      cachedTokens: 0,
      costUsd: 1,
    };

    const snap2 = bus.snapshot();
    expect(snap2.turnTokensIn).toBe(10);
    expect(snap2.byModel["anthropic/claude-sonnet-5"]!.tokensIn).toBe(10);
    expect(snap2.byModel["new-model"]).toBeUndefined();
  });
});

// ── subscribe / unsubscribe ──────────────────────────────────────────────────

describe("subscribe", () => {
  it("delivers updates to multiple subscribers", () => {
    const bus = createMetricsBus();
    const a: SessionMetrics[] = [];
    const b: SessionMetrics[] = [];
    bus.subscribe((m) => a.push(m));
    bus.subscribe((m) => b.push(m));

    bus.record(ev());
    bus.flush();

    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  it("stops delivering updates after unsubscribe", () => {
    const bus = createMetricsBus();
    const received: SessionMetrics[] = [];
    const unsubscribe = bus.subscribe((m) => received.push(m));

    bus.record(ev());
    bus.flush();
    expect(received.length).toBe(1);

    unsubscribe();
    bus.record(ev());
    bus.flush();
    expect(received.length).toBe(1);
  });

  it("isolates a throwing subscriber so other subscribers still receive updates", () => {
    const bus = createMetricsBus();
    const received: SessionMetrics[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((m) => received.push(m));

    expect(() => {
      bus.record(ev());
      bus.flush();
    }).not.toThrow();
    expect(received.length).toBe(1);
  });
});

// ── throttle ──────────────────────────────────────────────────────────────────

describe("throttle", () => {
  it("coalesces rapid records within the throttle window; flush forces an immediate settle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bus = createMetricsBus({ throttleMs: 100, throttleTokens: 200 });
    const received: SessionMetrics[] = [];
    bus.subscribe((m) => received.push(m));

    bus.record(ev({ tokensIn: 5, tokensOut: 5, costUsd: 0.01 }));
    bus.record(ev({ tokensIn: 5, tokensOut: 5, costUsd: 0.01 }));
    // Still within the throttle window — no notify has fired yet.
    expect(received.length).toBe(0);

    bus.flush();
    expect(received.length).toBe(1);
    expect(received[0]!.turnTokensIn).toBe(10);
    expect(received[0]!.turnTokensOut).toBe(10);
    expect(received[0]!.turnCostUsd).toBeCloseTo(0.02);
  });

  it("still fires a trailing notify once throttleMs elapses, without an explicit flush", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bus = createMetricsBus({ throttleMs: 50, throttleTokens: 1000 });
    const received: SessionMetrics[] = [];
    bus.subscribe((m) => received.push(m));

    bus.record(ev({ tokensIn: 1, tokensOut: 1, costUsd: 0.001 }));
    expect(received.length).toBe(0);

    vi.advanceTimersByTime(50);
    expect(received.length).toBe(1);
    expect(received[0]!.turnTokensIn).toBe(1);
  });

  it("notifies immediately once a burst accumulates at least throttleTokens, ignoring the timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bus = createMetricsBus({ throttleMs: 10_000, throttleTokens: 10 });
    const received: SessionMetrics[] = [];
    bus.subscribe((m) => received.push(m));

    // 6 + 6 = 12 tokens >= throttleTokens(10), well before throttleMs elapses.
    bus.record(ev({ tokensIn: 6, tokensOut: 0, costUsd: 0.001 }));
    expect(received.length).toBe(0);
    bus.record(ev({ tokensIn: 6, tokensOut: 0, costUsd: 0.001 }));
    expect(received.length).toBe(1);
    expect(received[0]!.turnTokensIn).toBe(12);
  });
});

// ── noteStreamChars (live burn while a call streams) ─────────────────────────

describe("noteStreamChars", () => {
  it("accumulates a ~chars/4 streamTokensOut estimate while a call streams", () => {
    const bus = createMetricsBus();
    bus.noteStreamChars(200);
    bus.noteStreamChars(200);
    expect(bus.snapshot().streamTokensOut).toBe(100);
  });

  it("zeroes the estimate when the call's real usage settles (model_call record), so displays never double-count", () => {
    const bus = createMetricsBus();
    bus.noteStreamChars(400);
    expect(bus.snapshot().streamTokensOut).toBe(100);

    bus.record(ev({ tokensOut: 120 }));
    const snap = bus.snapshot();
    expect(snap.streamTokensOut).toBe(0);
    expect(snap.turnTokensOut).toBe(120);
  });

  it("keeps the estimate across tool_call records — only a settled model call supersedes it", () => {
    const bus = createMetricsBus();
    bus.noteStreamChars(400);
    bus.record(
      ev({ kind: "tool_call", tokensIn: 0, tokensOut: 0, costUsd: 0 }),
    );
    expect(bus.snapshot().streamTokensOut).toBe(100);
  });

  it("resets on startTurn and flush, and ignores non-positive char counts", () => {
    const bus = createMetricsBus();
    bus.noteStreamChars(0);
    bus.noteStreamChars(-5);
    expect(bus.snapshot().streamTokensOut).toBe(0);

    bus.noteStreamChars(400);
    bus.startTurn();
    expect(bus.snapshot().streamTokensOut).toBe(0);

    bus.noteStreamChars(400);
    bus.flush();
    expect(bus.snapshot().streamTokensOut).toBe(0);
  });

  it("notifies subscribers (throttled) as the estimate grows, so the burn readout ticks mid-stream", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bus = createMetricsBus({ throttleMs: 10_000, throttleTokens: 50 });
    const received: SessionMetrics[] = [];
    bus.subscribe((m) => received.push(m));

    // 240 chars → 60 estimated tokens ≥ throttleTokens(50) → immediate notify.
    bus.noteStreamChars(240);
    expect(received.length).toBe(1);
    expect(received[0]!.streamTokensOut).toBe(60);
  });
});

// ── metricsEventFor ───────────────────────────────────────────────────────────

describe("metricsEventFor", () => {
  it("prices a non-zero-token call on a priced model above zero", () => {
    const event = metricsEventFor(
      "call-42",
      "model_call",
      "anthropic/claude-sonnet-5",
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      12_345,
    );

    expect(event.callId).toBe("call-42");
    expect(event.kind).toBe("model_call");
    expect(event.model).toBe("anthropic/claude-sonnet-5");
    expect(event.tokensIn).toBe(1_000_000);
    expect(event.tokensOut).toBe(1_000_000);
    expect(event.at).toBe(12_345);
    expect(event.costUsd).toBeGreaterThan(0);
  });

  it("defaults missing token directions to zero and prices to zero cost", () => {
    const event = metricsEventFor(
      "call-43",
      "tool_call",
      "anthropic/claude-sonnet-5",
      {},
      1,
    );
    expect(event.tokensIn).toBe(0);
    expect(event.tokensOut).toBe(0);
    expect(event.costUsd).toBe(0);
  });
});
