// usage-analytics.test.ts
//
// Unit tests for readUsageBreakdown (OXA-1585). The ClickHouse client is mocked
// so no live server is needed. We pin the tenant filter (org_id always; the
// optional workspace_id branch), the GROUP BY / ORDER BY of each grouped query,
// the string→number coercion of UInt64 sums, and the derivation of `totals` from
// `byModel` (so headline == table sum).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { readUsageBreakdown } from "./usage-analytics";

// Classify a query by its projection so returns don't depend on call ordering.
type Kind =
  | "series"
  | "model"
  | "surface"
  | "workspace"
  | "capability"
  | "principal"
  | "user";
function classify(query: string): Kind {
  if (query.includes("toDate(created_at)")) return "series";
  if (query.includes("any(provider)")) return "model";
  if (query.includes("SELECT surface AS group_key")) return "surface";
  if (query.includes("SELECT workspace_id AS group_key")) return "workspace";
  if (query.includes("SELECT capability_name AS group_key"))
    return "capability";
  if (query.includes("toString(principal_id) AS group_key")) return "principal";
  if (query.includes("toString(user_id) AS group_key")) return "user";
  throw new Error(`unclassified query: ${query.slice(0, 120)}`);
}

function mockRows(rows: Partial<Record<Kind, unknown[]>>): void {
  queryMock.mockImplementation(async (arg) => {
    // Vitest's teardown may re-invoke the spy with no args during cleanup;
    // tolerate it so the real query classification stays strict.
    if (!arg) return { json: async () => [] };
    const kind = classify(arg.query);
    return { json: async () => rows[kind] ?? [] };
  });
}

const agg = (o: Partial<Record<string, string>>) => ({
  input_tokens: "0",
  output_tokens: "0",
  cached_tokens: "0",
  cost_micros: "0",
  executions: "0",
  messages: "0",
  ...o,
});

beforeEach(() => queryMock.mockReset());
afterEach(() => vi.clearAllMocks());

const WINDOW = {
  orgId: "11111111-1111-1111-1111-111111111111",
  start: new Date("2026-06-01T00:00:00.000Z"),
  end: new Date("2026-07-01T00:00:00.000Z"),
};

describe("readUsageBreakdown", () => {
  it("parses grouped rows and derives totals from byModel", async () => {
    mockRows({
      series: [
        agg({
          input_tokens: "100",
          output_tokens: "40",
          cached_tokens: "10",
          cost_micros: "5000",
          executions: "3",
        }),
      ],
      model: [
        {
          group_key: "claude-sonnet-5",
          provider: "anthropic",
          ...agg({
            input_tokens: "80",
            output_tokens: "30",
            cached_tokens: "8",
            cost_micros: "4000",
            executions: "2",
            messages: "2",
          }),
        },
        {
          group_key: "gpt-5.5-pro",
          provider: "openai",
          ...agg({
            input_tokens: "20",
            output_tokens: "10",
            cached_tokens: "2",
            cost_micros: "1000",
            executions: "1",
            messages: "1",
          }),
        },
      ],
      surface: [
        {
          group_key: "api",
          ...agg({
            input_tokens: "100",
            output_tokens: "40",
            cached_tokens: "10",
            cost_micros: "5000",
            executions: "3",
          }),
        },
      ],
      workspace: [
        {
          group_key: "ws-a",
          ...agg({
            input_tokens: "100",
            output_tokens: "40",
            cached_tokens: "10",
            cost_micros: "5000",
            executions: "3",
          }),
        },
      ],
      capability: [
        {
          group_key: "query_ontology",
          ...agg({ input_tokens: "60", cost_micros: "3000", executions: "2" }),
        },
      ],
      principal: [
        {
          group_key: "00000000-0000-0000-0000-0000000000e5",
          provider: "agent",
          ...agg({ input_tokens: "60", cost_micros: "3000", executions: "2" }),
        },
      ],
      user: [
        {
          group_key: "00000000-0000-0000-0000-0000000000a1",
          ...agg({
            input_tokens: "100",
            output_tokens: "40",
            cost_micros: "5000",
            executions: "3",
            messages: "3",
          }),
        },
      ],
    });

    const out = await readUsageBreakdown(WINDOW);

    // Totals are the sum of the two model rows — not a separate query.
    expect(out.totals).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      costMicros: 5000,
      executions: 3,
      messages: 3,
    });
    expect(out.byModel[0]).toEqual({
      key: "claude-sonnet-5",
      provider: "anthropic",
      inputTokens: 80,
      outputTokens: 30,
      cachedTokens: 8,
      costMicros: 4000,
      executions: 2,
      messages: 2,
    });
    expect(out.bySurface[0]).toMatchObject({
      key: "api",
      provider: "",
      costMicros: 5000,
    });
    expect(out.byWorkspace[0]).toMatchObject({ key: "ws-a", provider: "" });
    // Principal-spine dimensions (migration 0023).
    expect(out.byCapability[0]).toMatchObject({
      key: "query_ontology",
      provider: "",
      costMicros: 3000,
      executions: 2,
    });
    expect(out.byPrincipal[0]).toEqual({
      principalId: "00000000-0000-0000-0000-0000000000e5",
      principalKind: "agent",
      inputTokens: 60,
      outputTokens: 0,
      cachedTokens: 0,
      costMicros: 3000,
      executions: 2,
      messages: 0,
    });
    // Per-user (seat-level) dimension keyed on token_usage.user_id.
    expect(out.byUser[0]).toEqual({
      userId: "00000000-0000-0000-0000-0000000000a1",
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 0,
      costMicros: 5000,
      executions: 3,
      messages: 3,
    });
  });

  it("maps the daily series with its day key", async () => {
    mockRows({
      series: [
        {
          day: "2026-06-01",
          ...agg({ input_tokens: "5", cost_micros: "70", executions: "1" }),
        },
        {
          day: "2026-06-02",
          ...agg({ input_tokens: "7", cost_micros: "90", executions: "2" }),
        },
      ],
    });
    const out = await readUsageBreakdown(WINDOW);
    expect(out.series).toEqual([
      {
        day: "2026-06-01",
        inputTokens: 5,
        outputTokens: 0,
        cachedTokens: 0,
        costMicros: 70,
        executions: 1,
        messages: 0,
      },
      {
        day: "2026-06-02",
        inputTokens: 7,
        outputTokens: 0,
        cachedTokens: 0,
        costMicros: 90,
        executions: 2,
        messages: 0,
      },
    ]);
  });

  it("falls back to an empty string when a model row's provider aggregate is null (OXA-2059)", async () => {
    // `any(provider)` can return null when ClickHouse has no non-null provider
    // value to aggregate over for a group — the byModel mapper must not surface
    // `null`/`undefined` to callers.
    mockRows({
      model: [
        {
          group_key: "unknown-model",
          provider: null,
          ...agg({ input_tokens: "1", executions: "1" }),
        },
      ],
    });
    const out = await readUsageBreakdown(WINDOW);
    expect(out.byModel[0]).toMatchObject({
      key: "unknown-model",
      provider: "",
    });
  });

  it("groups the model breakdown by key only (provider is an aggregate, not a GROUP BY column)", async () => {
    // Regression: `any(provider) AS provider` must NOT appear in GROUP BY, or
    // ClickHouse rejects the query with ILLEGAL_AGGREGATION (code 184).
    mockRows({});
    await readUsageBreakdown(WINDOW);
    const modelQuery = queryMock.mock.calls
      .map((c) => c[0]?.query ?? "")
      .find((q) => q.includes("any(provider)"));
    expect(modelQuery).toBeDefined();
    expect(modelQuery).toContain("GROUP BY group_key");
    expect(modelQuery).not.toMatch(/GROUP BY group_key\s*,\s*provider/);
  });

  it("always filters org_id and groups/orders every dimension", async () => {
    mockRows({});
    await readUsageBreakdown(WINDOW);
    for (const call of queryMock.mock.calls) {
      const { query, query_params } = call[0];
      expect(query).toContain("org_id = {orgId:UUID}");
      expect(query).toMatch(
        /GROUP BY group_key(?!\s*,\s*provider)|GROUP BY day/,
      );
      expect(query).toContain("created_at >= {start:DateTime64(3)}");
      expect(query).toContain("created_at <  {end:DateTime64(3)}");
      expect(query).toContain("GROUP BY");
      expect(query).toContain("ORDER BY");
      expect(query_params.orgId).toBe(WINDOW.orgId);
      // Z stripped so best_effort parses the DateTime64 param.
      expect(query_params.start).toBe("2026-06-01T00:00:00.000");
      expect(query_params.end).toBe("2026-07-01T00:00:00.000");
      // No workspace narrowing when workspaceId is absent.
      expect(query_params).not.toHaveProperty("workspaceId");
      expect(query).not.toContain("workspace_id = {workspaceId:UUID}");
    }
  });

  it("binds and applies the workspace filter when workspaceId is supplied", async () => {
    mockRows({});
    const wsId = "22222222-2222-2222-2222-222222222222";
    await readUsageBreakdown({ ...WINDOW, workspaceId: wsId });
    for (const call of queryMock.mock.calls) {
      const { query, query_params } = call[0];
      expect(query).toContain("AND workspace_id = {workspaceId:UUID}");
      expect(query_params.workspaceId).toBe(wsId);
    }
  });

  it("returns zeroed totals and empty breakdowns for an empty scope", async () => {
    mockRows({});
    const out = await readUsageBreakdown(WINDOW);
    expect(out.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costMicros: 0,
      executions: 0,
      messages: 0,
    });
    expect(out.series).toEqual([]);
    expect(out.byModel).toEqual([]);
    expect(out.bySurface).toEqual([]);
    expect(out.byWorkspace).toEqual([]);
  });
});
