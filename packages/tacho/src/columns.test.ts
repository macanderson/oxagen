import { describe, expect, it } from "vitest";
import { hashEvent } from "./chain";
import {
  ENVELOPE_COLUMNS,
  SERVER_STAMPED_COLUMNS,
  TACHO_EVENT_COLUMNS,
  flattenEvent,
  unflattenEvent,
} from "./columns";
import { BODY_MEMBER_NAMES, parseTachoEvent } from "./envelope";
import {
  asClickHouseRead,
  minimalSession,
  sealAll,
  unsealed,
} from "./test-helpers";

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

describe("unflattenEvent", () => {
  /** Events whose rows leave a reading open, each sealed into one chain. */
  function ambiguousSession() {
    return sealAll([
      unsealed(
        "agent_start",
        { session_start_source: "startup" },
        {
          turn: {},
          span: {},
          context: {},
          host: {},
          anthropic: {},
          content: { redactions: [] },
          attrs: { "oxagen.note": "kept" },
        },
      ),
      unsealed(
        "tool_call",
        { tool_name: "Read", tool_status: "ok" },
        {
          ts: "2026-09-08T10:06:04Z",
          subagent: { subagent_id: "sub_1", spawn_depth: 0 },
          parent_session_uuid: "0192d4a8-7c1e-7a00-8000-0000000000c1",
          harness_event_sequence: 9,
        },
      ),
      unsealed(
        "tool_call",
        { tool_name: "Bash", tool_status: "error" },
        {
          subagent: { subagent_id: "sub_1", subagent_type: "Explore" },
          context: { cwd: "/repo", git_dirty: false, model: "haiku" },
          host: { claude_pid: 42, has_tty: true },
          anthropic: { account_uuid: "acct_1" },
          span: { trace_id: "t1", span_id: "s1" },
          content: {
            digest: `sha256:${"b".repeat(64)}`,
            redactions: [
              {
                path: "bytes:0-4",
                reason: "github_token",
                original_digest: `sha256:${"c".repeat(64)}`,
              },
            ],
          },
        },
      ),
    ]);
  }

  it("rebuilds every event of a session from its flattened row", () => {
    for (const event of [...minimalSession(), ...ambiguousSession()]) {
      expect(unflattenEvent(flattenEvent(event))).toEqual(
        parseTachoEvent(event),
      );
    }
  });

  it("rebuilds every event from the row as ClickHouse reads it back", () => {
    for (const event of [...minimalSession(), ...ambiguousSession()]) {
      const read = asClickHouseRead(flattenEvent(event));
      expect(read["ts"]).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
      );
      expect(unflattenEvent(read)).toEqual(event);
    }
  });

  it("chooses the reading whose hash is the row's hash, not the likeliest one", () => {
    const [start] = ambiguousSession();
    if (!start) throw new Error("no event");
    const rebuilt = unflattenEvent(asClickHouseRead(flattenEvent(start)));
    expect(rebuilt?.turn).toEqual({});
    expect(rebuilt?.content).toEqual({ redactions: [] });
    expect(hashEvent(rebuilt as unknown as Record<string, unknown>)).toBe(
      start.hash,
    );
  });

  it("returns null for a row whose content was edited after sealing (negative)", () => {
    const event = minimalSession().find((e) => e.kind === "tool_call");
    if (!event) throw new Error("no event");
    const row = flattenEvent(event);
    expect(unflattenEvent({ ...row, kind: "file_io" })).toBeNull();
    expect(
      unflattenEvent({ ...row, body: JSON.stringify({ tool_name: "Write" }) }),
    ).toBeNull();
  });

  it("returns null where the row lost part of the event (negative)", () => {
    const [withAddress, precise] = sealAll([
      // The control plane never stores an address member (#3072).
      unsealed(
        "agent_start",
        {},
        { anthropic: { user_email_digest: `sha256:${"d".repeat(64)}` } },
      ),
      // ClickHouse keeps milliseconds only.
      unsealed("agent_stop", {}, { ts: "2026-09-08T10:06:03.123456Z" }),
    ]);
    if (!withAddress || !precise) throw new Error("no events");
    expect(unflattenEvent(flattenEvent(withAddress))).toBeNull();
    expect(unflattenEvent(asClickHouseRead(flattenEvent(precise)))).toBeNull();
  });

  it("returns null for a row with no hash or an unreadable body (negative)", () => {
    const [event] = minimalSession();
    if (!event) throw new Error("no event");
    const row = flattenEvent(event);
    expect(unflattenEvent({ ...row, hash: undefined })).toBeNull();
    expect(unflattenEvent({ ...row, body: "{" })).toBeNull();
    expect(unflattenEvent({ ...row, redactions: "[" })).toBeNull();
  });
});
