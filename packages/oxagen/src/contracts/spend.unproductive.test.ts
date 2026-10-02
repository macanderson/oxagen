import { describe, expect, it } from "vitest";
import { findingList } from "./finding.list";
import {
  spendUnproductive,
  UNPRODUCTIVE_ESTIMATE,
  UNPRODUCTIVE_PARTS,
} from "./spend.unproductive";

const usd = (micros: string) => ({ micros, currency: "USD" });
const zero = { saving: usd("0"), findings: 0 };

const out = {
  period: { from: "2026-09-01", to: "2026-09-30" },
  unproductive: usd("2000"),
  spend: usd("8000"),
  share: 0.25,
  parts: [
    { detector: 2, saving: usd("400"), findings: 2 },
    { detector: 3, ...zero },
    { detector: 5, saving: usd("600"), findings: 1 },
  ],
  estimate: { saving: usd("1500"), findings: 4 },
};

describe("get_unproductive_spend contract", () => {
  it("is a read over a day range for whoever reads the findings", () => {
    expect(spendUnproductive.mutates).toBe(false);
    expect(spendUnproductive.noBillingGate).toBe(true);
    expect(spendUnproductive.defaultEffect).toBe("deny");
    expect(spendUnproductive.defaultRoles).toEqual(findingList.defaultRoles);
    expect(
      spendUnproductive.input.safeParse({
        period: { from: "2026-09-01", to: "2026-09-30" },
      }).success,
    ).toBe(true);
    expect(spendUnproductive.input.safeParse({}).success).toBe(false);
  });

  it("carries the headline, its share, the three parts, and the estimate", () => {
    expect(spendUnproductive.output.parse(out)).toEqual(out);
  });

  it("carries no spend and no share when the spend has no figure", () => {
    expect(
      spendUnproductive.output.safeParse({ ...out, spend: null, share: null })
        .success,
    ).toBe(true);
  });

  it("refuses an answer that drops a part", () => {
    expect(
      spendUnproductive.output.safeParse({ ...out, parts: out.parts.slice(1) })
        .success,
    ).toBe(false);
  });

  it("names detectors 2, 3, and 5 as parts and 4 as the estimate, never a counting detector", () => {
    expect(UNPRODUCTIVE_PARTS.map((p) => p.detector)).toEqual([2, 3, 5]);
    expect(UNPRODUCTIVE_ESTIMATE.detector).toBe(4);
    const kinds = [
      ...UNPRODUCTIVE_PARTS.flatMap((p) => p.kinds),
      ...UNPRODUCTIVE_ESTIMATE.kinds,
    ];
    for (const counting of [
      "spin_loops",
      "duplicate_tool_calls",
      "repeated_shell_commands",
      "recurring_runs",
      "spend_with_no_outcome",
    ])
      expect(kinds).not.toContain(counting);
  });
});
