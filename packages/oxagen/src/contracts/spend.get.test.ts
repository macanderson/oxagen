import { describe, expect, it } from "vitest";
import {
  OTHER_SPEND_KEY,
  SPEND_TOP_RUNS_MAX,
  spendGet,
  spendRowSchema,
  spendTopRunSchema,
} from "./spend.get";
import { SPEND_RANGE_DAYS_MAX } from "./spend.shared";

const figure = {
  cost: { micros: "41265", currency: "USD", basis: "gateway_observed" },
  calls: 12,
  runs: 3,
  proven: null,
  accepted: null,
  productiveRatio: null,
};

describe("get_spend contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped, default-deny", () => {
    expect(spendGet.mutates).toBe(false);
    expect(spendGet.noBillingGate).toBe(true);
    expect(spendGet.scoped).toBe(true);
    expect(spendGet.defaultEffect).toBe("deny");
    expect(spendGet.layers).not.toContain("e2e");
  });

  it("is a low-risk read the in-app agent may call without approval", () => {
    expect(spendGet.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(spendGet.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "billing",
    });
  });

  it("takes an inclusive day range and one of the seven groupings, and nothing else", () => {
    expect(
      spendGet.input.parse({
        period: { from: "2026-09-01", to: "2026-09-30" },
        groupBy: "operator",
      }).groupBy,
    ).toBe("operator");
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-09-30", to: "2026-09-01" },
        groupBy: "agent",
      }).success,
    ).toBe(false);
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-02-30", to: "2026-03-01" },
        groupBy: "agent",
      }).success,
    ).toBe(false);
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-09-01", to: "2026-09-30" },
        groupBy: "repository",
      }).success,
    ).toBe(false);
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-09-01", to: "2026-09-30" },
        groupBy: "tool",
        filter: {},
      }).success,
    ).toBe(false);
  });

  it("caps the range at a quarter, so one read folds at most that many days of runs", () => {
    expect(SPEND_RANGE_DAYS_MAX).toBe(92);
    // 2026-07-01 to 2026-09-30 is 92 days; one more day is refused.
    expect(
      spendGet.input.safeParse({
        period: { from: "2026-07-01", to: "2026-09-30" },
        groupBy: "operator",
      }).success,
    ).toBe(true);
    const over = spendGet.input.safeParse({
      period: { from: "2026-07-01", to: "2026-10-01" },
      groupBy: "operator",
    });
    expect(over.success).toBe(false);
    expect(over.error?.issues.map((i) => i.path)).toEqual([["period", "to"]]);
    expect(
      spendGet.input.safeParse({
        period: { from: "2020-01-01", to: "2099-12-31" },
        groupBy: "operator",
      }).success,
    ).toBe(false);
  });

  it("carries every money figure as micros with a currency and a required basis, or null", () => {
    const row = {
      ...figure,
      key: "acme.core.cc",
      provider: null,
      operator: null,
      tokens: {
        input_uncached: 1,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        output: 1,
        reasoning: 0,
        server_tool_request: 0,
      },
      topRuns: [],
    };
    expect(spendRowSchema.parse(row)).toEqual(row);
    expect(spendRowSchema.parse({ ...row, cost: null }).cost).toBe(null);
    expect(
      spendRowSchema.safeParse({
        ...row,
        cost: { micros: "41265", currency: "USD" },
      }).success,
    ).toBe(false);
    expect(
      spendRowSchema.safeParse({
        ...row,
        cost: { micros: 41265, currency: "USD", basis: "mixed" },
      }).success,
    ).toBe(false);
    expect(
      spendRowSchema.safeParse({
        ...row,
        cost: { micros: "0.5", currency: "USD", basis: "estimated" },
      }).success,
    ).toBe(false);
    expect(
      spendRowSchema.safeParse({
        ...row,
        proven: { micros: "1", currency: "USD", basis: "mixed" },
      }).success,
    ).toBe(false);
  });

  it("groups by MCP server, which the daily rollup does not store", () => {
    expect(
      spendGet.input.parse({
        period: { from: "2026-09-01", to: "2026-09-30" },
        groupBy: "mcp_server",
      }).groupBy,
    ).toBe("mcp_server");
    // The key of the rest can never be a server name a harness spells.
    expect(OTHER_SPEND_KEY).not.toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("lists at most eight runs a row, each a run id with its part of the cost", () => {
    const top = {
      runId: "tse_0000000000000000000001",
      name: null,
      startedAt: "2026-09-10T12:00:00.000Z",
      agentKey: "acme.core.cc",
      harness: "codex",
      operatorKey: null,
      cost: { micros: "700", currency: "USD", basis: "estimated" },
      calls: 2,
    };
    expect(spendTopRunSchema.parse(top)).toEqual(top);
    expect(
      spendTopRunSchema.safeParse({ ...top, runId: "run_1" }).success,
    ).toBe(false);
    expect(SPEND_TOP_RUNS_MAX).toBe(8);
    const row = {
      ...figure,
      key: "github",
      provider: null,
      operator: null,
      tokens: {
        input_uncached: 0,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        output: 0,
        reasoning: 0,
        server_tool_request: 0,
      },
    };
    expect(
      spendRowSchema.safeParse({ ...row, topRuns: Array(9).fill(top) })
        .success,
    ).toBe(false);
  });

  it("carries a row's request windows summed, null where no run measured them (#5341)", () => {
    const row = {
      ...figure,
      key: "acme.core.cc",
      provider: null,
      operator: null,
      tokens: {
        input_uncached: 0,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        output: 0,
        reasoning: 0,
        server_tool_request: 0,
      },
      topRuns: [],
    };
    const windows = {
      runs: 2,
      requests: 9,
      requestsWithoutTokens: 1,
      promptTokens: 40_000,
      blocks: {
        system: 4_000,
        steering: null,
        tools: 12_000,
        context: null,
        conversation: 24_000,
      },
    };
    expect(spendRowSchema.parse({ ...row, windows })).toEqual({
      ...row,
      windows,
    });
    // Null says no run measured them; an answer built before the field
    // leaves it out.
    expect(spendRowSchema.parse({ ...row, windows: null }).windows).toBeNull();
    expect(spendRowSchema.parse(row)).not.toHaveProperty("windows");
    // A block is a count or null, never a fraction or a missing key.
    expect(
      spendRowSchema.safeParse({
        ...row,
        windows: { ...windows, blocks: { ...windows.blocks, system: 0.5 } },
      }).success,
    ).toBe(false);
    expect(
      spendRowSchema.safeParse({
        ...row,
        windows: {
          ...windows,
          blocks: { system: 4_000, steering: null, tools: 12_000, context: null },
        },
      }).success,
    ).toBe(false);
  });
});
