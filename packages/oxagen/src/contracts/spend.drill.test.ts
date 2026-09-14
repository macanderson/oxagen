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

  it("answers a daily series whose money is micros with a basis, or null", () => {
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
      byTool: [],
    };
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
});
