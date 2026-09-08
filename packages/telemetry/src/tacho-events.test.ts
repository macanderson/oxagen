import {
  GENESIS_CURSOR,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chInsert = vi.fn(
  async (_table: string, _rows: readonly Record<string, unknown>[]) => {},
);

vi.mock("./tenant", () => ({
  chInsert: (table: string, rows: readonly Record<string, unknown>[]) =>
    chInsert(table, rows),
}));

import { insertTachoEvents, tachoEventRow } from "./tacho-events";

const RECEIVED_AT = new Date("2026-09-08T10:07:00.000Z");
const SESSION = sessionUuid("tch_host", "sess-1");

function genesis(): TachoEvent {
  const unsealed = {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "sess-1",
    session_uuid: SESSION,
    root_session_uuid: SESSION,
    ts: "2026-09-08T10:06:03.000Z",
    fidelity: "sdk",
    source: "hook",
    agent: {
      agent_key: "acme.core.cc-laptop",
      fleet_id: "wrk_1",
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
    },
    attrs: { "hook.extra": "1" },
    kind: "agent_start",
    body: {
      session_start_source: "startup",
      tools_available: ["Read", "Bash"],
      mcp_servers: [{ name: "github", status: "connected" }],
    },
  } satisfies UnsealedTachoEvent;
  return sealEvent(unsealed, GENESIS_CURSOR).event;
}

beforeEach(() => {
  chInsert.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(RECEIVED_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("insertTachoEvents", () => {
  it("projects the flattened event onto the table's columns and stamps nothing tenant-shaped", () => {
    const row = tachoEventRow(
      { event: genesis(), chainVerified: true },
      RECEIVED_AT.toISOString(),
    );
    expect(row).toMatchObject({
      kind: "agent_start",
      seq: 0,
      session_uuid: SESSION,
      agent_key: "acme.core.cc-laptop",
      tools_available: ["Read", "Bash"],
      mcp_servers: JSON.stringify([{ name: "github", status: "connected" }]),
      attrs: { "hook.extra": "1" },
      chain_verified: true,
      received_at: RECEIVED_AT.toISOString(),
    });
    expect(row["org_id"]).toBeUndefined();
    expect(row["workspace_id"]).toBeUndefined();
    expect(typeof row["body"]).toBe("string");
  });

  it("appends through chInsert with a server-owned received_at and no-ops when empty", async () => {
    await insertTachoEvents([]);
    expect(chInsert).not.toHaveBeenCalled();
    await insertTachoEvents([{ event: genesis(), chainVerified: false }]);
    expect(chInsert).toHaveBeenCalledTimes(1);
    const [table, rows] = chInsert.mock.calls[0] ?? [];
    expect(table).toBe("tacho_events");
    expect(rows?.[0]).toMatchObject({
      chain_verified: false,
      received_at: RECEIVED_AT.toISOString(),
    });
  });

  it("drops a column the table does not have even if a caller smuggles it", () => {
    const event = genesis() as TachoEvent & { rogue?: string };
    const flat = { ...event, rogue: "x" };
    const row = tachoEventRow(
      { event: flat as TachoEvent, chainVerified: true },
      RECEIVED_AT.toISOString(),
    );
    expect(row["rogue"]).toBeUndefined();
  });
});
