// cost-frames.test.ts — the frame reads the spend rollup is rebuilt from,
// against a mocked ClickHouse client: the columns each store's query selects
// and the shape the rows come back in (docs/specs/tacho/data-model.md §2.7).
import { beforeEach, describe, expect, it, vi } from "vitest";

interface QueryCall {
  query: string;
  query_params: Record<string, unknown>;
}

const queryMock =
  vi.fn<(args: QueryCall) => Promise<{ json: () => Promise<unknown[]> }>>();

vi.mock("./clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clickhouse")>();
  return { ...actual, clickhouse: () => ({ query: queryMock }) };
});

import { readModelCallFrames, readTachoToolCallFrames } from "./cost-frames";

const ORG = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-0000000000aa";

function answer(rows: unknown[]): void {
  queryMock.mockResolvedValueOnce({ json: async () => rows });
}

function lastQuery(): QueryCall {
  return queryMock.mock.calls.at(-1)![0];
}

/** One `AS alias` per selected column, in select order. */
function selectedColumns(sql: string): string[] {
  return [...sql.matchAll(/^\s*(.+?)\s+AS\s+(\w+),?$/gm)].map((m) => m[2]!);
}

beforeEach(() => queryMock.mockReset());

describe("readModelCallFrames", () => {
  it("reads a wrapped run's token-bearing sources and prices OTel cache creation as 5m writes", async () => {
    // The OTel log, collector and hook sources carry `cache_creation_tokens`;
    // the 5m/1h split and thinking tokens exist only on transcript rows, which
    // the query leaves out, so a wrapped run's cache writes come from the one
    // column those sources populate.
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        input_uncached: "1000",
        cache_read: "200",
        cache_write_5m: "300",
        output: "50",
        cost_micros: "4125",
      },
      {
        at: "2026-09-14T10:00:01.000Z",
        model: "claude-sonnet-5",
        provider: "",
        input_uncached: "10",
        cache_read: "0",
        cache_write_5m: "0",
        output: "5",
        cost_micros: null,
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      run: { kind: "tacho", rootSessionUuid: RUN },
    });

    const { query, query_params } = lastQuery();
    expect(query).toContain("FROM tacho_events FINAL");
    expect(query).toContain("kind = 'llm_call'");
    expect(query).toContain(
      "coalesce(cache_creation_tokens, 0) AS cache_write_5m",
    );
    expect(query).not.toMatch(
      /cache_creation_5m_tokens|cache_creation_1h_tokens|thinking_tokens/,
    );
    expect(selectedColumns(query)).toEqual([
      "at",
      "input_uncached",
      "cache_read",
      "cache_write_5m",
      "output",
      "cost_micros",
    ]);
    expect(query_params).toEqual({
      orgId: ORG,
      rootSessionUuid: RUN,
      sources: ["otel_log", "collector", "hook"],
    });

    expect(frames).toEqual([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        inputUncached: 1000,
        cacheRead: 200,
        cacheWrite5m: 300,
        cacheWrite1h: 0,
        output: 50,
        reasoning: 0,
        reportedCostMicros: "4125",
        basis: "client_attested",
      },
      {
        at: "2026-09-14T10:00:01.000Z",
        model: "claude-sonnet-5",
        provider: null,
        inputUncached: 10,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 5,
        reasoning: 0,
        reportedCostMicros: null,
        basis: "client_attested",
      },
    ]);
  });

  it("reads a ledger run's gateway-metered rows as gateway_observed", async () => {
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "anthropic",
        input_uncached: "700",
        cache_read: "200",
        cache_write_5m: "100",
        output: "50",
        cost_micros: "3000",
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      run: { kind: "ledger", runUuid: RUN },
    });
    const { query, query_params } = lastQuery();
    expect(query).toContain("FROM token_usage");
    expect(query).toContain("cache_write_tokens   AS cache_write_5m");
    expect(query_params).toEqual({ orgId: ORG, runId: RUN });
    expect(frames).toEqual([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "anthropic",
        inputUncached: 700,
        cacheRead: 200,
        cacheWrite5m: 100,
        cacheWrite1h: 0,
        output: 50,
        reasoning: 0,
        reportedCostMicros: "3000",
        basis: "gateway_observed",
      },
    ]);
  });
});

describe("readTachoToolCallFrames", () => {
  it("reads the hook source's tool calls and hides an empty name", async () => {
    answer([{ name: "Bash" }, { name: "" }]);
    const frames = await readTachoToolCallFrames({
      orgId: ORG,
      rootSessionUuid: RUN,
    });
    const { query, query_params } = lastQuery();
    expect(query).toContain("kind = 'tool_call'");
    expect(query).toContain("source = 'hook'");
    expect(query_params).toEqual({ orgId: ORG, rootSessionUuid: RUN });
    expect(frames).toEqual([{ name: "Bash" }, { name: null }]);
  });
});
