import { describe, it, expect } from "vitest";
import { createSession, appendEvent, getEventsForTurn, getTurnCount, getTurnIds, endSession } from "./event-log";

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
