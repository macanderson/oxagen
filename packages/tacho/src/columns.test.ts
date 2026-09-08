import { describe, expect, it } from "vitest";
import {
  ENVELOPE_COLUMNS,
  SERVER_STAMPED_COLUMNS,
  TACHO_EVENT_COLUMNS,
  flattenEvent,
} from "./columns";
import { BODY_MEMBER_NAMES } from "./envelope";
import { minimalSession } from "./test-helpers";

describe("tacho_events columns", () => {
  it("has one column per body member and no name collides with an envelope column", () => {
    const envelope = new Set<string>(ENVELOPE_COLUMNS);
    for (const member of BODY_MEMBER_NAMES) {
      expect(envelope.has(member)).toBe(false);
      expect(TACHO_EVENT_COLUMNS).toContain(member);
    }
    expect(new Set(TACHO_EVENT_COLUMNS).size).toBe(TACHO_EVENT_COLUMNS.length);
    for (const stamped of SERVER_STAMPED_COLUMNS) {
      expect(TACHO_EVENT_COLUMNS).not.toContain(stamped);
    }
  });

  it("flattens every populated member to its column and drops nothing", () => {
    const events = minimalSession();
    const rows = events.map(flattenEvent);
    const known = new Set<string>(TACHO_EVENT_COLUMNS);
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        expect(known.has(column)).toBe(true);
        expect(value).not.toBeUndefined();
      }
      expect(row["org_id"]).toBeUndefined();
      expect(typeof row["body"]).toBe("string");
    }
    const toolRow = rows.find((row) => row["kind"] === "tool_call");
    expect(toolRow).toMatchObject({
      tool_name: "Read",
      tool_use_id: "toolu_1",
      tool_status: "ok",
      tool_duration_ms: 2,
      harness_session_id: events[0]?.session_id,
      turn_seq: 1,
      prompt_id: "p1",
      seq: 4,
    });
    const startRow = rows[0];
    expect(startRow?.["kind"]).toBe("agent_start");
    expect(startRow?.["prev_hash"]).toBe(events[0]?.prev_hash);
  });

  it("serialises nested body objects as JSON text and keeps arrays as arrays", () => {
    const events = minimalSession();
    const start = events[0];
    if (!start) {
      throw new Error("no genesis");
    }
    const withNested = {
      ...start,
      body: {
        ...start.body,
        mcp_servers: [{ name: "github", status: "connected" }],
        tools_available: ["Read"],
      },
    } as typeof start;
    const row = flattenEvent(withNested);
    expect(row["mcp_servers"]).toBe(
      JSON.stringify([{ name: "github", status: "connected" }]),
    );
    expect(row["tools_available"]).toEqual(["Read"]);
  });
});
