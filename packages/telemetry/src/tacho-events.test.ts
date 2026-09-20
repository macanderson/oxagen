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
const chSelect = vi.fn(
  async (_q: { query: string; params?: Record<string, unknown> }) => ({
    data: [] as unknown[],
  }),
);

vi.mock("./tenant", () => ({
  chInsert: (table: string, rows: readonly Record<string, unknown>[]) =>
    chInsert(table, rows),
  chSelect: (q: { query: string; params?: Record<string, unknown> }) =>
    chSelect(q),
}));

import {
  insertTachoEvents,
  selectTachoEvents,
  tachoEventRow,
} from "./tacho-events";

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
  chSelect.mockClear();
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

describe("bytes_ref is server-owned", () => {
  it("writes the control plane's body reference over anything the producer sent", () => {
    const row = tachoEventRow(
      {
        event: genesis(),
        chainVerified: true,
        bytesRef: "evb:v1:evidence:env:v1:" + "a".repeat(64),
      },
      RECEIVED_AT.toISOString(),
    );
    expect(row["bytes_ref"]).toBe("evb:v1:evidence:env:v1:" + "a".repeat(64));
  });

  it("blanks a producer's bytes_ref when the control plane retained no body (negative)", () => {
    const event = {
      ...genesis(),
      content: {
        digest: "sha256:" + "c".repeat(64),
        bytes_ref: "s3://host/x",
        redactions: [],
      },
    } as TachoEvent;
    const row = tachoEventRow(
      { event, chainVerified: true },
      RECEIVED_AT.toISOString(),
    );
    expect(row["content_digest"]).toBe("sha256:" + "c".repeat(64));
    expect(row["bytes_ref"]).toBe("");
  });
});

describe("selectTachoEvents", () => {
  it("reads past a sequence under FINAL and maps the frame columns", async () => {
    chSelect.mockResolvedValueOnce({
      data: [
        {
          seq: "3",
          ts: "2026-09-08 10:06:03.000",
          event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          kind: "tool_call",
          prev_hash: "sha256:" + "a".repeat(64),
          hash: "sha256:" + "b".repeat(64),
          content_digest: "sha256:" + "c".repeat(64),
          bytes_ref: "",
          redactions: "[]",
          body: '{"tool_name":"Bash"}',
          tool_name: "Bash",
          tool_status: "ok",
          tool_use_id: "toolu_1",
          model: "",
          provider: "",
          policy_decision: "allow",
          cost_usd_micros: null,
          turn_seq: "2",
        },
      ],
    });
    const rows = await selectTachoEvents({
      sessionUuid: SESSION,
      afterSeq: 2,
      limit: 10,
    });
    expect(rows).toEqual([
      {
        seq: 3,
        ts: "2026-09-08 10:06:03.000",
        eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        kind: "tool_call",
        prevHash: "sha256:" + "a".repeat(64),
        hash: "sha256:" + "b".repeat(64),
        contentDigest: "sha256:" + "c".repeat(64),
        bytesRef: "",
        redactions: "[]",
        body: '{"tool_name":"Bash"}',
        toolName: "Bash",
        toolStatus: "ok",
        toolUseId: "toolu_1",
        model: "",
        provider: "",
        policyDecision: "allow",
        costUsdMicros: null,
        turnSeq: 2,
        ttftMs: null,
        apiDurationMs: null,
      },
    ]);
    const [call] = chSelect.mock.calls[0] ?? [];
    expect(call?.query).toContain("FINAL");
    expect(call?.query).toContain("org_id = {orgId:UUID}");
    expect(call?.query).toContain("seq > {afterSeq:Int64}");
    expect(call?.params).toEqual({
      sessionUuid: SESSION,
      afterSeq: 2,
      limit: 10,
    });
  });
  it("maps recorded model timing without treating missing measurements as zero", async () => {
    chSelect.mockResolvedValueOnce({
      data: [
        { seq: "1", ttft_ms: "125", api_duration_ms: "2300" },
        { seq: "2", ttft_ms: 0, api_duration_ms: 0 },
        { seq: "3", ttft_ms: null, api_duration_ms: null },
      ],
    });
    const rows = await selectTachoEvents({
      sessionUuid: SESSION,
      afterSeq: 0,
      limit: 10,
    });
    expect(
      rows.map(({ ttftMs, apiDurationMs }) => ({ ttftMs, apiDurationMs })),
    ).toEqual([
      { ttftMs: 125, apiDurationMs: 2300 },
      { ttftMs: 0, apiDurationMs: 0 },
      { ttftMs: null, apiDurationMs: null },
    ]);
    expect(chSelect.mock.calls[0]?.[0]?.query).toContain("ttft_ms");
    expect(chSelect.mock.calls[0]?.[0]?.query).toContain("api_duration_ms");
  });
});
