import { describe, it, expect } from "vitest";
import {
  microsToCents,
  sliceFieldForKind,
  matchRuleForSlice,
  matchCustomerForSlice,
  priceAttributedUsage,
  type AttributionRuleMatch,
  type PricePlanRate,
  type UsageSliceKey,
} from "./reseller-pricing";

const slice: UsageSliceKey = {
  workspaceId: "ws-1",
  principalId: "prin-1",
  capabilityName: "run_agent",
};

describe("microsToCents", () => {
  it("converts micro-USD to whole cents, rounding half-up", () => {
    expect(microsToCents(0)).toBe(0);
    expect(microsToCents(10_000)).toBe(1); // 1 cent
    expect(microsToCents(1_000_000)).toBe(100); // $1
    expect(microsToCents(14_999)).toBe(1); // 1.4999c → 1
    expect(microsToCents(15_000)).toBe(2); // 1.5c → 2 (half up)
  });
});

describe("sliceFieldForKind", () => {
  it("maps each kind to its slice field", () => {
    expect(sliceFieldForKind(slice, "workspace")).toBe("ws-1");
    expect(sliceFieldForKind(slice, "principal")).toBe("prin-1");
    expect(sliceFieldForKind(slice, "capability")).toBe("run_agent");
  });
});

describe("matchRuleForSlice", () => {
  const rules: AttributionRuleMatch[] = [
    {
      customerId: "cust-cap",
      matchKind: "capability",
      matchValue: "run_agent",
      priority: 50,
    },
    {
      customerId: "cust-ws",
      matchKind: "workspace",
      matchValue: "ws-1",
      priority: 10,
    },
    {
      customerId: "cust-prin",
      matchKind: "principal",
      matchValue: "prin-1",
      priority: 30,
    },
  ];

  it("returns the lowest-priority-number matching rule (first match wins)", () => {
    const match = matchRuleForSlice(slice, rules);
    expect(match?.customerId).toBe("cust-ws"); // priority 10 beats 30 and 50
  });

  it("falls through to the next rule when the highest-priority one does not match", () => {
    const noWs: UsageSliceKey = { ...slice, workspaceId: "other" };
    const match = matchRuleForSlice(noWs, rules);
    expect(match?.customerId).toBe("cust-prin"); // ws no longer matches → principal (30)
  });

  it("returns null when no rule matches", () => {
    const match = matchRuleForSlice(
      { workspaceId: "x", principalId: "y", capabilityName: "z" },
      rules,
    );
    expect(match).toBeNull();
  });

  it("breaks ties on equal priority deterministically by matchValue", () => {
    const tied: AttributionRuleMatch[] = [
      {
        customerId: "b",
        matchKind: "workspace",
        matchValue: "ws-1",
        priority: 10,
      },
      {
        customerId: "a",
        matchKind: "capability",
        matchValue: "run_agent",
        priority: 10,
      },
    ];
    // matchValue "run_agent" > "ws-1"? localeCompare: "run_agent" vs "ws-1" → 'r' < 'w' so
    // capability sorts first. Deterministic regardless of input order.
    const first = matchRuleForSlice(slice, tied);
    const firstReversed = matchRuleForSlice(slice, [...tied].reverse());
    expect(first?.customerId).toBe(firstReversed?.customerId);
  });
});

describe("matchCustomerForSlice", () => {
  it("returns the matched customer id or null", () => {
    const rules: AttributionRuleMatch[] = [
      {
        customerId: "cust-1",
        matchKind: "workspace",
        matchValue: "ws-1",
        priority: 10,
      },
    ];
    expect(matchCustomerForSlice(slice, rules)).toBe("cust-1");
    expect(
      matchCustomerForSlice({ ...slice, workspaceId: "z" }, rules),
    ).toBeNull();
  });
});

describe("priceAttributedUsage", () => {
  const markup20: PricePlanRate = {
    pricingMode: "markup",
    markupBps: 2000,
    unitPriceCents: null,
  };
  const perUnit: PricePlanRate = {
    pricingMode: "per_unit",
    markupBps: null,
    unitPriceCents: 5,
  };

  it("applies a markup over raw cost (20% → ×1.2)", () => {
    expect(priceAttributedUsage(1000, 3, markup20)).toBe(1200);
    expect(priceAttributedUsage(0, 0, markup20)).toBe(0);
  });

  it("rounds the marked-up amount to whole cents", () => {
    // 999 * 1.2 = 1198.8 → 1199
    expect(priceAttributedUsage(999, 1, markup20)).toBe(1199);
  });

  it("prices per_unit as unit price × quantity, ignoring raw cost", () => {
    expect(priceAttributedUsage(9999, 4, perUnit)).toBe(20); // 5c × 4
    expect(priceAttributedUsage(0, 10, perUnit)).toBe(50);
  });

  it("treats a null plan as pass-through at raw cost", () => {
    expect(priceAttributedUsage(1234, 5, null)).toBe(1234);
  });

  it("defends against a malformed plan (missing rate → 0, never NaN)", () => {
    const badMarkup: PricePlanRate = {
      pricingMode: "markup",
      markupBps: null,
      unitPriceCents: null,
    };
    const badUnit: PricePlanRate = {
      pricingMode: "per_unit",
      markupBps: null,
      unitPriceCents: null,
    };
    expect(priceAttributedUsage(1000, 2, badMarkup)).toBe(1000); // markupBps 0 → ×1.0
    expect(priceAttributedUsage(1000, 2, badUnit)).toBe(0); // unit 0 × qty
  });

  it("never multiplies by a negative quantity", () => {
    expect(priceAttributedUsage(0, -3, perUnit)).toBe(0);
  });
});
