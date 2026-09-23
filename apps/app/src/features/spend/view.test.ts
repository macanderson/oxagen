// Which view a Spend request opens: a known tab or the first one, a drill only
// where get_spend_drill would accept its key, and one finding's evidence only
// where the finding contracts would accept its id.
import { describe, expect, it } from "vitest";
import { dayOf, monthToDate, parseSpendView } from "./view";

describe("parseSpendView", () => {
  it("opens the findings tab with nothing selected by default", () => {
    expect(parseSpendView({})).toEqual({
      tab: "findings",
      drill: null,
      finding: null,
    });
  });

  it("opens a known tab, reading the first of a repeated value", () => {
    expect(parseSpendView({ tab: "waste" })).toEqual({
      tab: "waste",
      drill: null,
      finding: null,
    });
    expect(parseSpendView({ tab: ["budgets", "agent"] })).toEqual({
      tab: "budgets",
      drill: null,
      finding: null,
    });
  });

  it.each(["tokens", "model"])(
    "opens %s without accepting an unsupported drill",
    (tab) => {
      expect(parseSpendView({ tab, drill: "anything" })).toEqual({
        tab,
        drill: null,
        finding: null,
      });
    },
  );

  it("opens an operator's, an agent's or a tool's drill", () => {
    expect(
      parseSpendView({ tab: "operator", drill: "prn_marcusbell" }),
    ).toEqual({ tab: "operator", drill: "prn_marcusbell", finding: null });
    expect(
      parseSpendView({ tab: "agent", drill: "acme/core-platform/triage" }),
    ).toEqual({
      tab: "agent",
      drill: "acme/core-platform/triage",
      finding: null,
    });
    expect(parseSpendView({ tab: "tool", drill: "github__merge" })).toEqual({
      tab: "tool",
      drill: "github__merge",
      finding: null,
    });
  });

  it("opens the pricing tab, which carries neither a drill nor a finding", () => {
    expect(parseSpendView({ tab: "pricing", drill: "prn_marcusbell" })).toEqual(
      {
        tab: "pricing",
        drill: null,
        finding: null,
      },
    );
  });

  it("opens one finding's evidence on the findings tab", () => {
    expect(
      parseSpendView({ tab: "findings", finding: "fnd_01k5rtgh" }),
    ).toEqual({ tab: "findings", drill: null, finding: "fnd_01k5rtgh" });
  });

  it.each([
    ["an id that is not a finding's", { finding: "01k5rtgh" }],
    ["an id of another kind", { finding: "arun_01k5rtgh" }],
    ["an empty id", { finding: "" }],
    ["an id carrying a path", { finding: "fnd_01/../x" }],
  ])(
    "ignores %s, opening the findings tab with none (negative)",
    (_case, params) => {
      expect(parseSpendView({ tab: "findings", ...params })).toEqual({
        tab: "findings",
        drill: null,
        finding: null,
      });
    },
  );

  it("does not carry a finding onto another tab (negative)", () => {
    expect(parseSpendView({ tab: "waste", finding: "fnd_01k5rtgh" })).toEqual({
      tab: "waste",
      drill: null,
      finding: null,
    });
  });

  it.each([
    [
      "an unknown tab",
      { tab: "reconciliation", drill: "prn_marcusbell" },
      "findings",
    ],
    ["a drill on a tab that has none", { tab: "waste", drill: "x" }, "waste"],
    [
      "an operator key that is not a principal id",
      { tab: "operator", drill: "marcus" },
      "operator",
    ],
    ["an empty key", { tab: "agent", drill: "" }, "agent"],
    [
      "a key longer than the contract takes",
      { tab: "tool", drill: "t".repeat(257) },
      "tool",
    ],
  ])("ignores %s (negative)", (_case, params, tab) => {
    expect(parseSpendView(params)).toEqual({
      tab,
      drill: null,
      finding: null,
    });
  });
});

describe("monthToDate", () => {
  it("reads from the first of today's UTC month through today", () => {
    expect(monthToDate(new Date("2026-09-15T23:30:00.000Z"))).toEqual({
      from: "2026-09-01",
      to: "2026-09-15",
    });
    expect(monthToDate(new Date("2026-10-01T00:00:00.000Z"))).toEqual({
      from: "2026-10-01",
      to: "2026-10-01",
    });
  });

  it("reads up to the clock's today when given none", () => {
    const { from, to } = monthToDate();
    expect(to).toBe(new Date().toISOString().slice(0, 10));
    expect(from).toBe(`${to.slice(0, 8)}01`);
  });
});

describe("dayOf", () => {
  it("is the one UTC day of the instant, for Fleet's Spend today tile", () => {
    expect(dayOf(new Date("2026-09-15T23:30:00.000Z"))).toEqual({
      from: "2026-09-15",
      to: "2026-09-15",
    });
  });
});
