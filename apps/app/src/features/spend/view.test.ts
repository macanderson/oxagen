// Which view a Spend request opens: a known tab or the first one, and a drill
// only where get_spend_drill would accept its key.
import { describe, expect, it } from "vitest";
import { dayOf, monthToDate, parseSpendView } from "./view";

describe("parseSpendView", () => {
  it("opens the operator tab with no drill by default", () => {
    expect(parseSpendView({})).toEqual({ tab: "operator", drill: null });
  });

  it("opens a known tab, reading the first of a repeated value", () => {
    expect(parseSpendView({ tab: "waste" })).toEqual({
      tab: "waste",
      drill: null,
    });
    expect(parseSpendView({ tab: ["budgets", "agent"] })).toEqual({
      tab: "budgets",
      drill: null,
    });
  });

  it("opens an operator's, an agent's or a tool's drill", () => {
    expect(
      parseSpendView({ tab: "operator", drill: "prn_marcusbell" }),
    ).toEqual({ tab: "operator", drill: "prn_marcusbell" });
    expect(
      parseSpendView({ tab: "agent", drill: "acme/core-platform/triage" }),
    ).toEqual({ tab: "agent", drill: "acme/core-platform/triage" });
    expect(parseSpendView({ tab: "tool", drill: "github__merge" })).toEqual({
      tab: "tool",
      drill: "github__merge",
    });
  });

  it.each([
    [
      "an unknown tab",
      { tab: "findings", drill: "prn_marcusbell" },
      "operator",
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
    expect(parseSpendView(params)).toEqual({ tab, drill: null });
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
