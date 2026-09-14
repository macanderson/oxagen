import { describe, expect, it } from "vitest";
import { spendWasteList } from "./spend.waste";

describe("list_waste contract", () => {
  it("is a console read over a day range", () => {
    expect(spendWasteList.noBillingGate).toBe(true);
    expect(spendWasteList.mutates).toBe(false);
    expect(
      spendWasteList.input.safeParse({
        period: { from: "2026-09-01", to: "2026-09-30" },
      }).success,
    ).toBe(true);
    expect(spendWasteList.input.safeParse({}).success).toBe(false);
  });

  it("names each cause, costs it with a basis, and cites at most ten runs", () => {
    const out = {
      period: { from: "2026-09-01", to: "2026-09-30" },
      wasted: { micros: "1200", currency: "USD", basis: "gateway_observed" },
      share: 0.03,
      runsWithWaste: 1,
      largestCause: "cache_write_never_read",
      causes: [
        {
          cause: "cache_write_never_read",
          wasted: {
            micros: "1200",
            currency: "USD",
            basis: "gateway_observed",
          },
          runs: 1,
          runIds: ["arun_1"],
        },
      ],
    };
    expect(spendWasteList.output.parse(out)).toEqual(out);
    expect(
      spendWasteList.output.parse({
        ...out,
        wasted: null,
        share: null,
        runsWithWaste: 0,
        largestCause: null,
        causes: [],
      }).wasted,
    ).toBe(null);
    expect(
      spendWasteList.output.safeParse({
        ...out,
        causes: [{ ...out.causes[0], cause: "retries" }],
      }).success,
    ).toBe(false);
    expect(
      spendWasteList.output.safeParse({
        ...out,
        causes: [
          {
            ...out.causes[0],
            runIds: Array.from({ length: 11 }, () => "arun_1"),
          },
        ],
      }).success,
    ).toBe(false);
  });
});
