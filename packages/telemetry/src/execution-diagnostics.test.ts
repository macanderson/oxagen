// execution-diagnostics.test.ts
//
// Unit tests for fetchErrorEventsForExecution / fetchLogsForExecution. The
// ClickHouse client is mocked so no live server is needed. We PIN the exact SQL
// shape (mocked CH happily accepts invalid SQL — memory: validate the query
// text, not just the JS return), the mandatory org_id + execution_id tenant
// filter, LIMIT clamping, the optional level-IN branch, the string→typed
// coercion, and the nil-UUID short-circuit (no query issued at all).

import { afterEach, describe, expect, it, vi } from "vitest";

interface QueryCall {
  query: string;
  query_params: Record<string, unknown>;
  format?: string;
}

const queryMock =
  vi.fn<(args: QueryCall) => Promise<{ json: () => Promise<unknown[]> }>>();

vi.mock("./clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clickhouse")>();
  return {
    ...actual,
    clickhouse: () => ({ query: queryMock }),
  };
});

import {
  fetchErrorEventsForExecution,
  fetchLogsForExecution,
} from "./execution-diagnostics";

const ORG = "11111111-1111-1111-1111-111111111111";
const EXEC = "22222222-2222-2222-2222-222222222222";
const NIL = "00000000-0000-0000-0000-000000000000";

function mockRows(rows: unknown[]): void {
  queryMock.mockImplementation(async () => ({ json: async () => rows }));
}

function lastCall(): QueryCall {
  const call = queryMock.mock.calls.at(-1)?.[0];
  if (!call) throw new Error("clickhouse().query was not called");
  return call;
}

afterEach(() => {
  queryMock.mockReset();
});

describe("fetchErrorEventsForExecution", () => {
  it("filters by org_id AND execution_id, orders newest-first, and binds a lookback floor", async () => {
    mockRows([]);
    await fetchErrorEventsForExecution({ orgId: ORG, executionId: EXEC });
    const { query, query_params, format } = lastCall();

    expect(query).toContain("FROM error_events");
    expect(query).toContain("org_id = {orgId:UUID}");
    expect(query).toContain("execution_id = {executionId:UUID}");
    expect(query).toContain("created_at >= {since:DateTime64(3)}");
    expect(query).toContain("ORDER BY created_at DESC");
    expect(query).toContain("LIMIT {limit:UInt32}");
    expect(format).toBe("JSONEachRow");
    expect(query_params.orgId).toBe(ORG);
    expect(query_params.executionId).toBe(EXEC);
    expect(query_params.limit).toBe(100);
    // Z-less, space-separated DateTime for the CH parser.
    expect(query_params.since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(String(query_params.since)).not.toContain("Z");
  });

  it("clamps limit to the 500 ceiling and floors sub-1 values to the default", async () => {
    mockRows([]);
    await fetchErrorEventsForExecution({
      orgId: ORG,
      executionId: EXEC,
      limit: 100000,
    });
    expect(lastCall().query_params.limit).toBe(500);

    await fetchErrorEventsForExecution({
      orgId: ORG,
      executionId: EXEC,
      limit: 0,
    });
    expect(lastCall().query_params.limit).toBe(100);
  });

  it("short-circuits to [] for the nil-UUID sentinel without querying", async () => {
    mockRows([{ error_id: "x" }]);
    const out = await fetchErrorEventsForExecution({
      orgId: ORG,
      executionId: NIL,
    });
    expect(out).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("coerces the raw row and maps NULL/nil step_id to null", async () => {
    mockRows([
      {
        error_id: "e1",
        severity: "error",
        source: "runner",
        error_class: "TypeError",
        message: "boom",
        stack: "at f (/a/b.ts:1:2)",
        capability: "execute_code",
        request_id: "req-1",
        fingerprint: "fp1",
        step_id: "\\N",
        created_at: "2026-07-06 00:00:00.000",
      },
      {
        error_id: "e2",
        severity: "fatal",
        source: "api",
        error_class: "Error",
        message: "x",
        stack: "",
        capability: "",
        request_id: "",
        fingerprint: "fp2",
        step_id: "33333333-3333-3333-3333-333333333333",
        created_at: "2026-07-06 00:00:01.000",
      },
    ]);
    const out = await fetchErrorEventsForExecution({
      orgId: ORG,
      executionId: EXEC,
    });
    expect(out[0]).toMatchObject({
      errorId: "e1",
      errorClass: "TypeError",
      stepId: null,
    });
    expect(out[1]).toMatchObject({
      errorId: "e2",
      severity: "fatal",
      stepId: "33333333-3333-3333-3333-333333333333",
    });
  });
});

describe("fetchLogsForExecution", () => {
  it("omits the level filter when no levels are given", async () => {
    mockRows([]);
    await fetchLogsForExecution({ orgId: ORG, executionId: EXEC });
    const { query, query_params } = lastCall();
    expect(query).toContain("FROM execution_logs");
    expect(query).toContain("org_id = {orgId:UUID}");
    expect(query).toContain("execution_id = {executionId:UUID}");
    expect(query).not.toContain("log_level IN");
    expect(query_params.levels).toBeUndefined();
  });

  it("adds a log_level IN filter when levels are supplied", async () => {
    mockRows([]);
    await fetchLogsForExecution({
      orgId: ORG,
      executionId: EXEC,
      levels: ["warn", "error", "fatal"],
    });
    const { query, query_params } = lastCall();
    expect(query).toContain("log_level IN {levels:Array(String)}");
    expect(query_params.levels).toEqual(["warn", "error", "fatal"]);
  });

  it("short-circuits to [] for the nil-UUID sentinel without querying", async () => {
    mockRows([{ log_level: "error" }]);
    const out = await fetchLogsForExecution({ orgId: ORG, executionId: NIL });
    expect(out).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("coerces rows and maps NULL step_id to null", async () => {
    mockRows([
      {
        step_id: "\\N",
        log_level: "error",
        message: "failed to fetch",
        metadata: "{}",
        created_at: "2026-07-06 00:00:00.000",
      },
    ]);
    const out = await fetchLogsForExecution({ orgId: ORG, executionId: EXEC });
    expect(out[0]).toEqual({
      stepId: null,
      logLevel: "error",
      message: "failed to fetch",
      metadata: "{}",
      createdAt: "2026-07-06 00:00:00.000",
    });
  });
});
