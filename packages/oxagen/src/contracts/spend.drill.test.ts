import { describe, expect, it } from "vitest";
import { DRILL_DAYS_DEFAULT, DRILL_DAYS_MAX, spendDrill } from "./spend.drill";

describe("get_spend_drill contract", () => {
  it("is a console read on the three drillable levels", () => {
    expect(spendDrill.noBillingGate).toBe(true);
    expect(spendDrill.mutates).toBe(false);
    expect(
      spendDrill.input.parse({ kind: "operator", key: "prn_1" }).days,
    ).toBe(DRILL_DAYS_DEFAULT);
    expect(
      spendDrill.input.safeParse({ kind: "model", key: "claude" }).success,
    ).toBe(false);
    expect(spendDrill.input.safeParse({ kind: "tool", key: "" }).success).toBe(
      false,
    );
    expect(
      spendDrill.input.safeParse({
        kind: "agent",
        key: "a.b.c",
        days: DRILL_DAYS_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it("is a low-risk read the in-app agent may call without approval", () => {
    expect(spendDrill.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(spendDrill.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "billing",
    });
  });

  it("takes an operator key as a principal public id and any bounded string for an agent or a tool", () => {
    // The key an operator row of get_spend and a run of list_runs carry; the
    // store filters on that column, so an agent key or a uuid is refused here.
    const operator = spendDrill.input.safeParse({
      kind: "operator",
      key: "acme.core.cc",
    });
    expect(operator.success).toBe(false);
    expect(operator.error?.issues.map((i) => i.path)).toEqual([["key"]]);
    expect(
      spendDrill.input.safeParse({
        kind: "operator",
        key: "0192d4a8-7c1e-7a00-8000-0000000000a1",
      }).success,
    ).toBe(false);
    expect(
      spendDrill.input.safeParse({
        kind: "operator",
        key: "prn_0123456789abcdefghjkmn",
      }).success,
    ).toBe(true);
    expect(
      spendDrill.input.safeParse({ kind: "agent", key: "acme.core.cc" })
        .success,
    ).toBe(true);
    expect(
      spendDrill.input.safeParse({ kind: "tool", key: "Bash" }).success,
    ).toBe(true);
  });

  const tokens = {
    input_uncached: 1200,
    cache_read: 800,
    cache_write_5m: 0,
    cache_write_1h: 0,
    output: 300,
    reasoning: 0,
    server_tool_request: 0,
  };
  const estimated = { micros: "2400", currency: "USD", basis: "estimated" };
  const out = {
    kind: "tool",
    key: "Bash",
    period: { from: "2026-08-16", to: "2026-09-14" },
    total: {
      cost: null,
      calls: 4,
      runs: 2,
      proven: null,
      accepted: null,
      productiveRatio: null,
    },
    series: [{ day: "2026-08-16", cost: null, calls: 0, runs: 0 }],
    averages: { perCall: null, perRun: null },
    share: null,
    tokens,
    cacheHitRate: 0.4,
    modelCalls: 6,
    observed: null,
    standing: {
      toolDefinitionTokens: null,
      contextFrameTokens: null,
      steeringTokens: null,
    },
    resultTokens: null,
    byTool: [],
    byAgent: [],
    byOperator: [],
    byModel: [],
  };

  it("answers a daily series whose money is micros with a basis, or null", () => {
    expect(spendDrill.output.parse(out)).toEqual(out);
    expect(
      spendDrill.output.safeParse({
        ...out,
        series: [
          {
            day: "2026-08-16",
            cost: { micros: "1", currency: "USD" },
            calls: 1,
            runs: 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(spendDrill.output.safeParse({ ...out, share: 1.2 }).success).toBe(
      false,
    );
  });

  it("answers a tool's result tokens and their estimate with a basis, and each cross-cut row whole", () => {
    const row = {
      key: "acme.core.cc",
      provider: null,
      operator: null,
      runs: 2,
      calls: 4,
      cost: estimated,
      tokens,
      resultTokens: 800,
    };
    const full = {
      ...out,
      total: { ...out.total, cost: estimated },
      resultTokens: 800,
      byTool: [
        { name: "Bash", calls: 4, runs: 2, resultTokens: 800, cost: estimated },
      ],
      byAgent: [row],
      byOperator: [
        {
          ...row,
          key: "prn_0123456789abcdefghjkmn",
          operator: {
            id: "prn_0123456789abcdefghjkmn",
            name: "Marcus Bell",
            email: null,
            avatarUrl: null,
            role: null,
          },
        },
      ],
    };
    expect(spendDrill.output.parse(full)).toEqual(full);
    // A tool's estimate is a cost, so it carries the basis that says so.
    expect(
      spendDrill.output.safeParse({
        ...full,
        byTool: [
          {
            name: "Bash",
            calls: 4,
            runs: 2,
            resultTokens: 800,
            cost: { micros: "2400", currency: "USD" },
          },
        ],
      }).success,
    ).toBe(false);
    // A cross-cut row carries every token class, and nothing else.
    expect(
      spendDrill.output.safeParse({
        ...full,
        byAgent: [{ ...row, tokens: { input_uncached: 1 } }],
      }).success,
    ).toBe(false);
    expect(
      spendDrill.output.safeParse({ ...full, byModel: [{ ...row, share: 1 }] })
        .success,
    ).toBe(false);
  });

  it("refuses a cache hit rate above one and a drill without its tokens (negative)", () => {
    expect(
      spendDrill.output.safeParse({ ...out, cacheHitRate: 1.5 }).success,
    ).toBe(false);
    const withoutTokens = Object.fromEntries(
      Object.entries(out).filter(([key]) => key !== "tokens"),
    );
    expect(spendDrill.output.safeParse(withoutTokens).success).toBe(false);
  });
});
