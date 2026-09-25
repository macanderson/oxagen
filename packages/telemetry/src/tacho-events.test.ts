import {
  ENVELOPE_COLUMNS,
  GENESIS_CURSOR,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chInsert = vi.fn(
  async (
    _table: string,
    _rows: readonly Record<string, unknown>[],
    _settings?: Record<string, unknown>,
  ) => {},
);
const chSelect = vi.fn(
  async (_q: { query: string; params?: Record<string, unknown> }) => ({
    data: [] as unknown[],
  }),
);

vi.mock("./tenant", () => ({
  chInsert: (
    table: string,
    rows: readonly Record<string, unknown>[],
    settings?: Record<string, unknown>,
  ) => chInsert(table, rows, settings),
  chSelect: (q: { query: string; params?: Record<string, unknown> }) =>
    chSelect(q),
}));

import {
  insertTachoEvents,
  TACHO_EVENTS_INSERT_MAX_MEMORY_BYTES,
  TACHO_EVENTS_INSERT_SETTINGS,
  selectAgentDaySpend,
  selectTachoEventRecords,
  selectTachoEvents,
  selectTachoStoredFrames,
  selectTachoSubagentEvents,
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

  it("bounds the insert's memory and keeps the node from stopping it for another query's memory (#3662)", async () => {
    await insertTachoEvents([{ event: genesis(), chainVerified: true }]);
    const [, , settings] = chInsert.mock.calls[0] ?? [];
    expect(settings).toBe(TACHO_EVENTS_INSERT_SETTINGS);
    expect(settings).toEqual({
      max_memory_usage: "536870912",
      memory_overcommit_ratio_denominator: "0",
      memory_overcommit_ratio_denominator_for_user: "0",
    });
    // The bound sits well above the largest batch a host may send (4 MiB of
    // JSON) and well below the app node's 1.5 GiB server cap.
    expect(TACHO_EVENTS_INSERT_MAX_MEMORY_BYTES).toBeGreaterThan(
      100 * 4 * 1_048_576,
    );
    expect(TACHO_EVENTS_INSERT_MAX_MEMORY_BYTES).toBeLessThan(
      1_610_612_736 / 2,
    );
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
        effort: "",
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
  it("reads the effort a model call ran at, and an empty string where none was recorded", async () => {
    chSelect.mockResolvedValueOnce({
      data: [
        { seq: "1", effort: "high" },
        { seq: "2", effort: "" },
        { seq: "3" },
      ],
    });
    const rows = await selectTachoEvents({
      sessionUuid: SESSION,
      afterSeq: 0,
      limit: 10,
    });
    expect(rows.map(({ effort }) => effort)).toEqual(["high", "", ""]);
    expect(chSelect.mock.calls.at(-1)?.[0]?.query).toContain("effort");
  });
});

describe("selectTachoEvents: an upper bound", () => {
  it("bounds the read at throughSeq when the caller knows where it ends", async () => {
    chSelect.mockReset();
    chSelect.mockResolvedValueOnce({ data: [] });
    await selectTachoEvents({
      sessionUuid: SESSION,
      afterSeq: 99,
      throughSeq: 599,
      limit: 500,
    });
    const [call] = chSelect.mock.calls[0] ?? [];
    expect(call?.query).toContain("seq <= {throughSeq:Int64}");
    expect(call?.params).toEqual({
      sessionUuid: SESSION,
      afterSeq: 99,
      throughSeq: 599,
      limit: 500,
    });
  });

  it("reads to the chain's end when no bound is given (negative)", async () => {
    chSelect.mockReset();
    chSelect.mockResolvedValueOnce({ data: [] });
    await selectTachoEvents({ sessionUuid: SESSION, afterSeq: 99, limit: 500 });
    const [call] = chSelect.mock.calls[0] ?? [];
    expect(call?.query).not.toContain("throughSeq");
    expect(call?.params).not.toHaveProperty("throughSeq");
  });
});

describe("selectTachoSubagentEvents", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";

  it("reads every subagent chain under a root, FINAL, with each chain's identity", async () => {
    chSelect.mockReset();
    chSelect.mockResolvedValueOnce({
      data: [
        {
          seq: "0",
          ts: "2026-09-08 10:06:04.000",
          kind: "agent_start",
          session_uuid: CHILD,
          root_session_uuid: SESSION,
          parent_session_uuid: SESSION,
          subagent_id: "agent-1",
          subagent_type: "Explore",
          spawn_tool_use_id: "toolu_task",
          spawn_depth: "1",
        },
      ],
    });
    const rows = await selectTachoSubagentEvents({
      rootSessionUuid: SESSION,
      after: null,
      limit: 50,
    });
    expect(rows[0]).toMatchObject({
      seq: 0,
      kind: "agent_start",
      sessionUuid: CHILD,
      rootSessionUuid: SESSION,
      parentSessionUuid: SESSION,
      subagentId: "agent-1",
      subagentType: "Explore",
      spawnToolUseId: "toolu_task",
      spawnDepth: 1,
    });
    const [call] = chSelect.mock.calls[0] ?? [];
    expect(call?.query).toContain("FINAL");
    expect(call?.query).toContain("root_session_uuid = {rootSessionUuid:UUID}");
    // The root's own chain is read by selectTachoEvents, never twice.
    expect(call?.query).toContain("session_uuid != {rootSessionUuid:UUID}");
    expect(call?.query).toContain("ORDER BY session_uuid ASC, seq ASC");
    expect(call?.query).not.toContain("afterSession");
    expect(call?.params).toEqual({ rootSessionUuid: SESSION, limit: 50 });
  });

  it("resumes after the last (session, seq) it read", async () => {
    chSelect.mockReset();
    chSelect.mockResolvedValueOnce({ data: [] });
    await selectTachoSubagentEvents({
      rootSessionUuid: SESSION,
      after: { sessionUuid: CHILD, seq: 7 },
      limit: 50,
    });
    const [call] = chSelect.mock.calls[0] ?? [];
    expect(call?.query).toContain(
      "(session_uuid, seq) > ({afterSession:UUID}, {afterSeq:UInt64})",
    );
    expect(call?.params).toEqual({
      rootSessionUuid: SESSION,
      afterSession: CHILD,
      afterSeq: 7,
      limit: 50,
    });
  });
});

describe("selectTachoSubagentEvents: listed chains", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";

  it("reads only the listed chains, through the primary key", async () => {
    chSelect.mockReset();
    chSelect.mockResolvedValueOnce({ data: [] });
    await selectTachoSubagentEvents({
      rootSessionUuid: SESSION,
      sessionUuids: [CHILD],
      after: null,
      limit: 50,
    });
    const [call] = chSelect.mock.calls[0] ?? [];
    expect(call?.query).toContain("session_uuid IN {sessionUuids:Array(UUID)}");
    // The root filter stays, so a listed chain from another run reads nothing.
    expect(call?.query).toContain("root_session_uuid = {rootSessionUuid:UUID}");
    expect(call?.params).toEqual({
      rootSessionUuid: SESSION,
      sessionUuids: [CHILD],
      limit: 50,
    });
  });

  it("filters on the root alone when no chains are listed (negative)", async () => {
    chSelect.mockReset();
    chSelect.mockResolvedValueOnce({ data: [] });
    await selectTachoSubagentEvents({
      rootSessionUuid: SESSION,
      after: null,
      limit: 50,
    });
    const [call] = chSelect.mock.calls[0] ?? [];
    expect(call?.query).not.toContain("sessionUuids");
  });
});

describe("selectTachoStoredFrames", () => {
  it("answers the stored hash of each asked seq, and asks nothing for none", async () => {
    chSelect.mockReset();
    expect(
      await selectTachoStoredFrames({ sessionUuid: SESSION, seqs: [] }),
    ).toEqual(new Map());
    expect(chSelect).not.toHaveBeenCalled();
    chSelect.mockResolvedValueOnce({
      data: [
        {
          seq: "2",
          hash: "sha256:" + "b".repeat(64),
          content_digest: "",
          bytes_ref: "",
        },
      ],
    });
    const stored = await selectTachoStoredFrames({
      sessionUuid: SESSION,
      seqs: [2, 3],
    });
    expect(stored.get(2)?.hash).toBe("sha256:" + "b".repeat(64));
    expect(stored.has(3)).toBe(false);
    const [call] = chSelect.mock.calls[0] ?? [];
    expect(call?.query).toContain("FINAL");
    expect(call?.query).toContain("seq IN {seqs:Array(UInt64)}");
    expect(call?.params).toEqual({ sessionUuid: SESSION, seqs: [2, 3] });
  });
});

describe("selectTachoEventRecords", () => {
  it("reads every envelope column beside the frame row, and leaves the server's bytes_ref off the envelope", async () => {
    const event = genesis();
    const stored = tachoEventRow(
      { event, chainVerified: true, bytesRef: "evb:v1:k1:" + "a".repeat(64) },
      RECEIVED_AT.toISOString(),
    );
    chSelect.mockResolvedValueOnce({
      data: [{ ...stored, seq: "0", ts: "2026-09-08 10:06:03.000" }],
    });
    const [record] = await selectTachoEventRecords({
      sessionUuid: SESSION,
      afterSeq: -1,
      limit: 500,
    });
    expect(record?.frame).toMatchObject({
      seq: 0,
      hash: event.hash,
      bytesRef: "evb:v1:k1:" + "a".repeat(64),
    });
    expect(record?.envelope["bytes_ref"]).toBeUndefined();
    expect(record?.envelope["hash"]).toBe(event.hash);
    expect(record?.envelope["ts"]).toBe("2026-09-08 10:06:03.000");
    expect(Object.keys(record?.envelope ?? {}).sort()).toEqual(
      ENVELOPE_COLUMNS.filter((c) => c !== "bytes_ref").sort(),
    );

    const [call] = chSelect.mock.calls.at(-1) ?? [];
    expect(call?.query).toContain("toString(ts) AS ts");
    expect(call?.query).toContain("`attrs`");
    expect(call?.query).toContain("`tool_name`");
    expect(call?.query).toContain("FINAL");
    expect(call?.query).toContain("seq > {afterSeq:Int64}");
    expect(call?.params).toEqual({
      sessionUuid: SESSION,
      afterSeq: -1,
      limit: 500,
    });
  });
});

describe("selectAgentDaySpend (ADR-160)", () => {
  it("sums the proxy's priced calls per host by the frame's own UTC day", async () => {
    chSelect.mockResolvedValueOnce({
      data: [
        { host_enrollment_id: "tch_a", micros: "11100" },
        { host_enrollment_id: "tch_b", micros: 2500 },
        { host_enrollment_id: "tch_c", micros: "0" },
      ],
    });
    const spend = await selectAgentDaySpend({
      day: "2026-09-24",
      hostEnrollmentIds: ["tch_a", "tch_b", "tch_c"],
    });
    expect([...spend]).toEqual([
      ["tch_a", 11_100],
      ["tch_b", 2_500],
    ]);
    const [call] = chSelect.mock.calls[0] ?? [];
    // The frame's timestamp decides the day, never when it was received.
    expect(call?.query).toContain(
      "ts >= toDateTime64({start:String}, 3, 'UTC')",
    );
    expect(call?.query).not.toContain("received_at");
    for (const predicate of [
      "kind = 'llm_call'",
      "source = 'collector'",
      "fidelity = 'proxy'",
      "attrs[{meteringAttr:String}] = {metered:String}",
      "cost_usd_micros IS NOT NULL",
      "host_enrollment_id IN {hosts:Array(String)}",
      "ts < toDateTime64({start:String}, 3, 'UTC') + INTERVAL 1 DAY",
      "FROM tacho_events FINAL",
      "GROUP BY host_enrollment_id",
    ])
      expect(call?.query).toContain(predicate);
    expect(call?.params).toMatchObject({
      hosts: ["tch_a", "tch_b", "tch_c"],
      meteringAttr: "oxagen.metering",
      metered: "observed",
      start: "2026-09-24 00:00:00.000",
    });
  });

  it("asks nothing of ClickHouse for an agent with no hosts (negative)", async () => {
    const spend = await selectAgentDaySpend({
      day: "2026-09-24",
      hostEnrollmentIds: [],
    });
    expect(spend.size).toBe(0);
    expect(chSelect).not.toHaveBeenCalled();
  });
});
