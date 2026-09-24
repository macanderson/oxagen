// Which view a Spend path opens: the bare path is Findings, a known tab
// segment is that tab, a drill segment only where get_spend_drill would accept
// its key, and one finding's evidence only where the finding contracts would
// accept its id. Anything else is a 404 (null).
import { describe, expect, it } from "vitest";
import { dayOf, monthToDate, parseSpendView, SPEND_TABS } from "./view";

describe("parseSpendView", () => {
  it("opens the findings tab with nothing selected on the bare path", () => {
    expect(parseSpendView(undefined)).toEqual({
      tab: "findings",
      drill: null,
      finding: null,
    });
    expect(parseSpendView([])).toEqual({
      tab: "findings",
      drill: null,
      finding: null,
    });
  });

  it("lists the design's nine tabs first, in the design's order", () => {
    expect(SPEND_TABS.slice(0, 9)).toEqual([
      "findings",
      "tokens",
      "coaching",
      "operator",
      "agent",
      "model",
      "tool",
      "waste",
      "budgets",
    ]);
  });

  it.each(SPEND_TABS)("opens the %s tab from its segment", (tab) => {
    expect(parseSpendView([tab])).toEqual({
      tab,
      drill: null,
      finding: null,
    });
  });

  it("opens an operator's, an agent's or a tool's drill", () => {
    expect(parseSpendView(["operator", "prn_marcusbell"])).toEqual({
      tab: "operator",
      drill: "prn_marcusbell",
      finding: null,
    });
    expect(parseSpendView(["agent", "acme.core.triage"])).toEqual({
      tab: "agent",
      drill: "acme.core.triage",
      finding: null,
    });
    expect(parseSpendView(["tool", "github__merge"])).toEqual({
      tab: "tool",
      drill: "github__merge",
      finding: null,
    });
  });

  it("opens one finding's evidence on the findings tab, reading the first of a repeated value", () => {
    expect(parseSpendView(undefined, "fnd_01k5rtgh")).toEqual({
      tab: "findings",
      drill: null,
      finding: "fnd_01k5rtgh",
    });
    expect(parseSpendView(["findings"], ["fnd_01k5rtgh", "fnd_2"])).toEqual({
      tab: "findings",
      drill: null,
      finding: "fnd_01k5rtgh",
    });
  });

  it.each([
    ["an id that is not a finding's", "01k5rtgh"],
    ["an id of another kind", "arun_01k5rtgh"],
    ["an empty id", ""],
    ["an id carrying a path", "fnd_01/../x"],
  ])(
    "ignores %s, opening the findings tab with none (negative)",
    (_case, finding) => {
      expect(parseSpendView(undefined, finding)).toEqual({
        tab: "findings",
        drill: null,
        finding: null,
      });
    },
  );

  it("does not carry a finding onto another tab (negative)", () => {
    expect(parseSpendView(["waste"], "fnd_01k5rtgh")).toEqual({
      tab: "waste",
      drill: null,
      finding: null,
    });
  });

  it.each([
    ["an unknown tab", ["reconciliation"]],
    ["a drill on a tab that has none", ["waste", "x"]],
    ["a drill on the model tab", ["model", "claude-opus-5"]],
    ["an operator key that is not a principal id", ["operator", "marcus"]],
    ["an empty key", ["agent", ""]],
    ["a key longer than the contract takes", ["tool", "t".repeat(257)]],
    ["a third segment", ["agent", "acme.core.triage", "extra"]],
  ])("answers no view for %s (negative)", (_case, segments) => {
    expect(parseSpendView(segments)).toBeNull();
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
