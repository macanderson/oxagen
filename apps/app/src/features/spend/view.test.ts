// Which view a Spend path opens: the bare path is Month, grouped by work item
// unless the query names another grouping, a known tab segment is that tab, a
// drill segment only where get_spend_drill would accept its key, and one
// finding's evidence only where the finding contracts would accept its id.
// Anything else is a 404 (null).
import { describe, expect, it } from "vitest";
import {
  dayOf,
  monthToDate,
  parseSpendView,
  SPEND_MONTH_BY,
  SPEND_TABS,
} from "./view";

describe("parseSpendView", () => {
  it("opens the Month tab grouped by work item on the bare path, as the design does (#2962)", () => {
    const month = {
      tab: "month",
      drill: null,
      finding: null,
      by: "work_item",
    };
    expect(parseSpendView(undefined)).toEqual(month);
    expect(parseSpendView([])).toEqual(month);
    expect(parseSpendView(["month"])).toEqual(month);
  });

  it("offers the design's five groupings in its order, Work item first (#2962)", () => {
    expect(SPEND_MONTH_BY).toEqual([
      "work_item",
      "agent",
      "operator",
      "model",
      "mcp_server",
    ]);
  });

  it.each(SPEND_MONTH_BY)("groups the Month tab by %s from the query", (by) => {
    expect(parseSpendView(undefined, undefined, by)).toEqual({
      tab: "month",
      drill: null,
      finding: null,
      by,
    });
    expect(parseSpendView(["month"], undefined, [by, "agent"])).toEqual({
      tab: "month",
      drill: null,
      finding: null,
      by,
    });
  });

  it.each([
    ["a grouping the tab does not offer", "tool"],
    ["an empty grouping", ""],
    ["a grouping in another case", "Operator"],
  ])("groups by work item for %s (negative)", (_case, by) => {
    expect(parseSpendView(undefined, undefined, by)).toEqual({
      tab: "month",
      drill: null,
      finding: null,
      by: "work_item",
    });
  });

  it("does not carry a grouping onto another tab (negative)", () => {
    expect(parseSpendView(["findings"], undefined, "model")).toEqual({
      tab: "findings",
      drill: null,
      finding: null,
      cursor: null,
    });
  });

  it("lists Month first, then the earlier design's five tabs it keeps in its order", () => {
    expect(SPEND_TABS.slice(0, 6)).toEqual([
      "month",
      "findings",
      "tokens",
      "tool",
      "waste",
      "budgets",
    ]);
  });

  it.each(SPEND_TABS.filter((tab) => tab !== "month"))(
    "opens the %s tab from its segment",
    (tab) => {
      expect(parseSpendView([tab])).toEqual({
        tab,
        drill: null,
        finding: null,
        ...(tab === "findings" ? { cursor: null } : {}),
      });
    },
  );

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
    expect(parseSpendView(["findings"], "fnd_01k5rtgh")).toEqual({
      tab: "findings",
      drill: null,
      finding: "fnd_01k5rtgh",
      cursor: null,
    });
    expect(parseSpendView(["findings"], ["fnd_01k5rtgh", "fnd_2"])).toEqual({
      tab: "findings",
      drill: null,
      finding: "fnd_01k5rtgh",
      cursor: null,
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
      expect(parseSpendView(["findings"], finding)).toEqual({
        tab: "findings",
        drill: null,
        finding: null,
        cursor: null,
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

  it("opens the page of the findings list a cursor names, with or without a finding's evidence (#5303)", () => {
    expect(
      parseSpendView(["findings"], undefined, undefined, "WyJvcGVuIl0"),
    ).toEqual({
      tab: "findings",
      drill: null,
      finding: null,
      cursor: "WyJvcGVuIl0",
    });
    expect(
      parseSpendView(["findings"], "fnd_01k5rtgh", undefined, [
        "WyJvcGVuIl0",
        "x",
      ]),
    ).toEqual({
      tab: "findings",
      drill: null,
      finding: "fnd_01k5rtgh",
      cursor: "WyJvcGVuIl0",
    });
  });

  it.each([
    ["an empty cursor", ""],
    ["a cursor with a path in it", "abc/../x"],
    ["a cursor past the bound", "a".repeat(257)],
  ])("opens the first page for %s (negative)", (_case, cursor) => {
    expect(parseSpendView(["findings"], undefined, undefined, cursor)).toEqual(
      { tab: "findings", drill: null, finding: null, cursor: null },
    );
  });

  it("carries no cursor onto another tab (negative)", () => {
    expect(parseSpendView(["waste"], undefined, undefined, "WyJvcGVuIl0"))
      .toEqual({ tab: "waste", drill: null, finding: null });
  });

  it("opens a finding saved on the bare path on the findings tab, from when Findings was the landing tab", () => {
    expect(parseSpendView(undefined, "fnd_01k5rtgh")).toEqual({
      tab: "findings",
      drill: null,
      finding: "fnd_01k5rtgh",
      cursor: null,
    });
  });

  it("opens Month on the bare path when its finding is not a finding's id (negative)", () => {
    expect(parseSpendView(undefined, "arun_01k5rtgh")).toEqual({
      tab: "month",
      drill: null,
      finding: null,
      by: "work_item",
    });
  });

  it.each([
    ["an unknown tab", ["reconciliation"]],
    ["a drill on a tab that has none", ["waste", "x"]],
    ["a drill on the Month tab", ["month", "acme.core.triage"]],
    ["a drill on the model tab", ["model", "claude-opus-5"]],
    ["the Coaching tab, which Month replaced", ["coaching"]],
    ["the By operator tab, which Month replaced", ["operator"]],
    ["the By agent tab, which Month replaced", ["agent"]],
    ["the By model tab, which Month replaced", ["model"]],
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
