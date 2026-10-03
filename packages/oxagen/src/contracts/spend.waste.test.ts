import { describe, expect, it } from "vitest";
import {
  UNPRODUCTIVE_ESTIMATE,
  UNPRODUCTIVE_PARTS,
} from "./spend.unproductive";
import {
  spendWasteList,
  WASTE_CLAIM_CAUSES,
  wasteCauseSchema,
} from "./spend.waste";

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

  it("refuses a range longer than a quarter", () => {
    expect(
      spendWasteList.input.safeParse({
        period: { from: "2026-07-01", to: "2026-09-30" },
      }).success,
    ).toBe(true);
    expect(
      spendWasteList.input.safeParse({
        period: { from: "2026-07-01", to: "2026-10-01" },
      }).success,
    ).toBe(false);
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
          provingRuns: [{ runId: "arun_1", name: "Repair the login redirect" }],
        },
      ],
      findingsOutsidePeriod: 0,
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
    expect(
      spendWasteList.output.safeParse({
        ...out,
        causes: [
          {
            ...out.causes[0],
            provingRuns: Array.from({ length: 11 }, () => ({
              runId: "arun_1",
              name: null,
            })),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      spendWasteList.output.safeParse({
        ...out,
        causes: [
          {
            ...out.causes[0],
            provingRuns: [{ runId: "arun_1", name: "x".repeat(257) }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  // #5294: the calls findings claim are causes too, beside the cache write.
  it("names each claimed cause, and counts the open findings outside the period", () => {
    const row = (cause: string, micros: string) => ({
      cause,
      wasted: { micros, currency: "USD", basis: "client_attested" },
      runs: 1,
      runIds: ["tse_1"],
      provingRuns: [{ runId: "tse_1", name: null }],
    });
    const out = {
      period: { from: "2026-10-01", to: "2026-10-02" },
      wasted: { micros: "3100", currency: "USD", basis: "client_attested" },
      share: 0.01,
      runsWithWaste: 1,
      largestCause: "repeated_calls",
      causes: [
        row("repeated_calls", "1800"),
        row("spin_loops", "500"),
        row("retry_loops", "400"),
        row("recurring_runs", "200"),
        row("spend_with_no_outcome", "100"),
        row("cache_write_never_read", "100"),
      ],
      findingsOutsidePeriod: 4,
    };
    expect(spendWasteList.output.parse(out)).toEqual(out);
    const { findingsOutsidePeriod: _dropped, ...without } = out;
    expect(spendWasteList.output.safeParse(without).success).toBe(false);
    expect(
      spendWasteList.output.safeParse({ ...out, findingsOutsidePeriod: -1 })
        .success,
    ).toBe(false);
  });

  it("groups each claiming finding kind under one cause in counting order, apart from the parts and the estimate", () => {
    const detectors = WASTE_CLAIM_CAUSES.map((c) => c.detector);
    expect(detectors).toEqual([...detectors].sort((a, b) => a - b));
    const kinds = WASTE_CLAIM_CAUSES.flatMap((c) => [...c.kinds]);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.sort()).toEqual(
      [
        "duplicate_tool_calls",
        "recurring_runs",
        "repeated_shell_commands",
        "retry_loops",
        "spend_with_no_outcome",
        "spin_loops",
      ].sort(),
    );
    const priced: readonly string[] = [
      ...UNPRODUCTIVE_PARTS.flatMap((p) => p.kinds),
      ...UNPRODUCTIVE_ESTIMATE.kinds,
    ];
    for (const kind of kinds) expect(priced).not.toContain(kind);
    expect([
      "cache_write_never_read",
      ...WASTE_CLAIM_CAUSES.map((c) => c.cause),
    ]).toEqual(wasteCauseSchema.options);
  });
});
