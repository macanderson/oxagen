// sandbox-logs.test.ts
//
// Read-path coverage for fetchSandboxLogs (the sandbox inspector's log console).
//
// Regression guard: the query MUST NOT alias `toString(ts) AS ts`. In ClickHouse
// a SELECT alias that reuses the source column name shadows the raw column in the
// WHERE/ORDER BY clauses, so `WHERE ts >= {since:DateTime64(3)}` binds to the
// String alias and the whole query aborts with:
//   "No operation greaterOrEquals between String and DateTime64(3)".
// That error looped in the sandbox inspector's Logs panel after warming a sandbox.
// The column is projected as `ts_text`; the raw `ts` column stays intact for the
// range filter and ordering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
  })),
);

vi.mock("@clickhouse/client", () => ({ createClient: createClientMock }));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    CLICKHOUSE_URL: "https://ch.example",
    CLICKHOUSE_USERNAME: "u",
    CLICKHOUSE_PASSWORD: "p",
    CLICKHOUSE_DATABASE: "db",
  }),
}));

const ORG = "00000000-0000-0000-0000-0000000000a1";
const WS = "00000000-0000-0000-0000-0000000000b2";

describe("fetchSandboxLogs", () => {
  let queryMock: ReturnType<typeof vi.fn>;
  let mod: typeof import("./sandbox-logs");

  beforeEach(async () => {
    queryMock = vi.fn();
    createClientMock.mockImplementation(() => ({
      close: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
      query: queryMock,
    }));
    vi.resetModules();
    mod = await import("./sandbox-logs");
    const { clickhouse } = await import("./clickhouse");
    clickhouse(); // prime the singleton against the mock client
  });

  afterEach(async () => {
    const { closeClickhouse } = await import("./clickhouse");
    await closeClickhouse();
    vi.resetModules();
  });

  it("returns [] without querying when sessionId is empty", async () => {
    const rows = await mod.fetchSandboxLogs({
      orgId: ORG,
      workspaceId: WS,
      sessionId: "",
    });
    expect(rows).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("does NOT alias toString(ts) back to `ts` (String-vs-DateTime64 regression)", async () => {
    queryMock.mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });

    await mod.fetchSandboxLogs({
      orgId: ORG,
      workspaceId: WS,
      sessionId: "sbx_1",
    });

    const sql: string = queryMock.mock.calls[0]![0].query;
    // The offending alias must never come back: it re-binds `ts` in WHERE/ORDER BY
    // to the String projection and breaks the DateTime64 range comparison.
    expect(sql).not.toMatch(/toString\(ts\)\s+AS\s+ts\b/);
    expect(sql).toContain("toString(ts) AS ts_text");
    // The raw DateTime64 column must still drive the range filter and ordering.
    expect(sql).toContain("AND ts >= {since:DateTime64(3)}");
    expect(sql).toContain("ORDER BY ts DESC, seq DESC");
  });

  it("maps ClickHouse rows (ts_text) to SandboxLogLine, oldest-first", async () => {
    // Query returns newest-first; fetchSandboxLogs reverses to chronological order.
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([
        {
          ts_text: "2026-07-08 10:00:02.000",
          stream: "stderr",
          level: "debug",
          command: "pnpm build",
          seq: 2,
          line: "warn",
          exit_code: null,
          duration_ms: null,
        },
        {
          ts_text: "2026-07-08 10:00:01.000",
          stream: "stdout",
          level: "normal",
          command: "pnpm build",
          seq: 1,
          line: "built ok",
          exit_code: 0,
          duration_ms: 1200,
        },
      ]),
    });

    const rows = await mod.fetchSandboxLogs({
      orgId: ORG,
      workspaceId: WS,
      sessionId: "sbx_1",
    });

    expect(rows).toEqual([
      {
        ts: "2026-07-08 10:00:01.000",
        stream: "stdout",
        level: "normal",
        command: "pnpm build",
        seq: 1,
        line: "built ok",
        exitCode: 0,
        durationMs: 1200,
      },
      {
        ts: "2026-07-08 10:00:02.000",
        stream: "stderr",
        level: "debug",
        command: "pnpm build",
        seq: 2,
        line: "warn",
        exitCode: null,
        durationMs: null,
      },
    ]);
  });

  it("adds `AND level = 'normal'` only when the Debug toggle is off", async () => {
    queryMock.mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });

    await mod.fetchSandboxLogs({
      orgId: ORG,
      workspaceId: WS,
      sessionId: "sbx_1",
      level: "normal",
    });
    expect(queryMock.mock.calls[0]![0].query).toContain("AND level = 'normal'");

    queryMock.mockClear();
    await mod.fetchSandboxLogs({
      orgId: ORG,
      workspaceId: WS,
      sessionId: "sbx_1",
      level: "debug",
    });
    expect(queryMock.mock.calls[0]![0].query).not.toContain(
      "AND level = 'normal'",
    );
  });

  it("clamps the limit to the 2000 ceiling and passes a DateTime64 `since` param", async () => {
    queryMock.mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });

    await mod.fetchSandboxLogs({
      orgId: ORG,
      workspaceId: WS,
      sessionId: "sbx_1",
      limit: 999_999,
      sinceMs: Date.UTC(2026, 6, 8, 10, 0, 0),
    });

    const params = queryMock.mock.calls[0]![0].query_params;
    expect(params.limit).toBe(2000);
    // chDateTime → 'YYYY-MM-DD HH:MM:SS.mmm' (no ISO T/Z), parseable as DateTime64(3).
    expect(params.since).toBe("2026-07-08 10:00:00.000");
    expect(params.since).not.toMatch(/[TZ]/);
  });
});
