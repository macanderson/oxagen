import { describe, it, expect } from "vitest";
import {
  createSession,
  appendEvent,
  getEventsForTurn,
  getTurnCount,
  getTurnIds,
  endSession,
} from "./event-log";
import { forkSession, getFullHistory } from "./fork";
import { extractTurnMetrics } from "./replay";

const NS = { org: "test-org", workspace: "test-ws" };

describe("Session event log", () => {
  it("creates a session with a session_start event", () => {
    const session = createSession("sess-1", NS);
    expect(session.id).toBe("sess-1");
    expect(session.status).toBe("active");
    expect(session.events).toHaveLength(1);
    expect(session.events[0]!.type).toBe("session_start");
  });

  it("appends events and increments index", () => {
    const session = createSession("sess-2", NS);
    appendEvent(session, "turn_start", "turn-1", { taskFrame: {} });
    appendEvent(session, "tool_call", "turn-1", { tool: "grep" });
    appendEvent(session, "turn_end", "turn-1", { outcome: "success" });

    expect(session.events).toHaveLength(4); // session_start + 3
    expect(session.events[1]!.index).toBe(1);
    expect(session.events[3]!.index).toBe(3);
  });

  it("filters events by turn ID", () => {
    const session = createSession("sess-3", NS);
    appendEvent(session, "turn_start", "turn-1", {});
    appendEvent(session, "tool_call", "turn-1", { tool: "read" });
    appendEvent(session, "turn_start", "turn-2", {});
    appendEvent(session, "tool_call", "turn-2", { tool: "write" });

    const turn1Events = getEventsForTurn(session, "turn-1");
    expect(turn1Events).toHaveLength(2);
    const turn2Events = getEventsForTurn(session, "turn-2");
    expect(turn2Events).toHaveLength(2);
  });

  it("counts turns correctly", () => {
    const session = createSession("sess-4", NS);
    appendEvent(session, "turn_start", "t1", {});
    appendEvent(session, "turn_end", "t1", {});
    appendEvent(session, "turn_start", "t2", {});
    appendEvent(session, "turn_end", "t2", {});
    expect(getTurnCount(session)).toBe(2);
    expect(getTurnIds(session)).toEqual(["t1", "t2"]);
  });

  it("ends a session and prevents further appends", () => {
    const session = createSession("sess-5", NS);
    endSession(session, "task complete");
    expect(session.status).toBe("completed");
    expect(() => appendEvent(session, "turn_start", "t1", {})).toThrow();
  });
});

describe("Session fork", () => {
  it("forks a session at a given event index", () => {
    const parent = createSession("parent", NS);
    appendEvent(parent, "turn_start", "t1", {});
    appendEvent(parent, "tool_call", "t1", { tool: "read" });
    appendEvent(parent, "turn_end", "t1", { outcome: "success" });

    const forked = forkSession(parent, 2, "forked-1");
    expect(forked.id).toBe("forked-1");
    expect(forked.parentId).toBe("parent");
    expect(forked.forkPoint).toBe(2);
    expect(forked.status).toBe("active");
  });

  it("throws for invalid fork point", () => {
    const session = createSession("sess", NS);
    expect(() => forkSession(session, 10, "bad")).toThrow();
  });

  it("getFullHistory resolves parent prefix", () => {
    const parent = createSession("parent", NS);
    appendEvent(parent, "turn_start", "t1", {});
    appendEvent(parent, "turn_end", "t1", {});

    const forked = forkSession(parent, 1, "forked");
    appendEvent(forked, "turn_start", "t2", {});

    const history = getFullHistory(forked, (id) =>
      id === "parent" ? parent : null,
    );
    expect(history.inherited).toBe(2); // parent's first 2 events (index 0,1)
    expect(history.events.length).toBeGreaterThan(2); // parent prefix + forked own events
  });

  it("getFullHistory keeps the grandparent prefix across a fork-of-a-fork", () => {
    const grandparent = createSession("gp", NS);
    appendEvent(grandparent, "turn_start", "g1", {});
    appendEvent(grandparent, "turn_end", "g1", {});

    // parent forks from grandparent after its first turn (index 2 = turn_end)
    const parent = forkSession(grandparent, 2, "parent");
    appendEvent(parent, "turn_start", "p1", {});
    appendEvent(parent, "turn_end", "p1", {});

    // child forks from parent after the parent's own turn (index 2 in the
    // parent's OWN event array: [session_start, turn_start, turn_end])
    const child = forkSession(parent, 2, "child");
    appendEvent(child, "turn_start", "c1", {});

    const byId: Record<string, ReturnType<typeof createSession>> = {
      gp: grandparent,
      parent,
      child,
    };
    const history = getFullHistory(child, (id) => byId[id] ?? null);

    // Inherited prefix = grandparent's 3 events (session_start, turn_start,
    // turn_end) + parent's own 2 events (its session_start is skipped).
    expect(history.inherited).toBe(5);
    // The grandparent's events must actually be present, not dropped.
    expect(history.events.slice(0, 3).map((e) => e.type)).toEqual([
      "session_start",
      "turn_start",
      "turn_end",
    ]);
    // And the child's own turn follows the inherited prefix.
    expect(history.events[history.events.length - 1]!.type).toBe("turn_start");
  });

  it("getFullHistory tolerates a corrupt parentId cycle", () => {
    const a = createSession("a", NS);
    appendEvent(a, "turn_start", "t", {});
    const b = forkSession(a, 1, "b");
    // Corrupt the chain: a claims to be forked from b.
    a.parentId = "b";
    a.forkPoint = 0;
    const byId: Record<string, ReturnType<typeof createSession>> = { a, b };
    const history = getFullHistory(b, (id) => byId[id] ?? null);
    // No infinite recursion; falls back to a bounded history.
    expect(history.events.length).toBeGreaterThan(0);
  });
});

describe("extractTurnMetrics", () => {
  it("extracts per-turn metrics from session events", () => {
    const session = createSession("metrics-test", NS);
    appendEvent(session, "turn_start", "t1", {});
    appendEvent(session, "context_compiled", "t1", {
      compileMs: 8,
      totalTokens: 5000,
      cacheHitRate: 0.72,
      candidatesRetrieved: 20,
      candidatesPacked: 5,
      candidatesEvicted: 15,
    });
    appendEvent(session, "tool_call", "t1", { tool: "grep" });
    appendEvent(session, "tool_call", "t1", { tool: "read" });
    appendEvent(session, "turn_end", "t1", { outcome: "success" });

    const metrics = extractTurnMetrics(session);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.compileMs).toBe(8);
    expect(metrics[0]!.tokens).toBe(5000);
    expect(metrics[0]!.toolCalls).toBe(2);
    expect(metrics[0]!.outcome).toBe("success");
  });
});
