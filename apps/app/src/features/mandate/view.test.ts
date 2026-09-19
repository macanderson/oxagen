// What the mandate page's query string selects, and what the ledger's search,
// facet and pager return. These are pure functions over the rows the read
// answered, so they are tested here rather than through the page: the page's
// suite proves what is rendered, this one proves what is selected.
import { describe, expect, it } from "vitest";
import { mandateMovement } from "@/test/mandate-views";
import {
  LEDGER_PAGE,
  ledgerPage,
  MANDATE_ID,
  mandateLink,
  MOVEMENT_STATES,
  parseMandateView,
} from "./view";

const at = { org: "a-intel", ws: "core-platform", mandate: "mnd_4f2a9c" };

describe("MANDATE_ID", () => {
  it("accepts the public-id shape the contract accepts", () => {
    expect(MANDATE_ID.test("mnd_4f2a9c")).toBe(true);
    expect(MANDATE_ID.test("mnd_7K2ETQ4")).toBe(true);
  });

  // A URL that could never name a mandate is a 404 rather than a kernel
  // invalid_input rendered as "this mandate could not be loaded".
  it("refuses anything that is not one (negative)", () => {
    for (const value of ["", "mnd_", "agt_4f2a9c", "not-a-mandate", "mnd 4f"]) {
      expect(MANDATE_ID.test(value)).toBe(false);
    }
  });
});

describe("parseMandateView", () => {
  it("defaults to no search, every state and the first page", () => {
    expect(parseMandateView({})).toEqual({
      search: null,
      state: null,
      offset: 0,
    });
  });

  it("takes the search trimmed, and reads a blank box as no search", () => {
    expect(parseMandateView({ q: "  pi_3Qa  " }).search).toBe("pi_3Qa");
    expect(parseMandateView({ q: "   " }).search).toBeNull();
  });

  it("bounds the search, so a crafted URL cannot hand the filter an unbounded string", () => {
    expect(parseMandateView({ q: "x".repeat(5000) }).search).toHaveLength(200);
  });

  it("takes each movement state the facet offers", () => {
    for (const state of MOVEMENT_STATES) {
      expect(parseMandateView({ state }).state).toBe(state);
    }
  });

  // A value the page does not recognise falls back to the default rather than
  // failing the page.
  it("ignores a state nobody records (negative)", () => {
    expect(parseMandateView({ state: "spent" }).state).toBeNull();
  });

  it("snaps an offset to a page boundary and ignores one that is not a number", () => {
    expect(parseMandateView({ offset: "25" }).offset).toBe(25);
    expect(parseMandateView({ offset: "30" }).offset).toBe(25);
    expect(parseMandateView({ offset: "-5" }).offset).toBe(0);
    expect(parseMandateView({ offset: "many" }).offset).toBe(0);
  });

  it("takes the first value when a parameter is repeated", () => {
    expect(parseMandateView({ state: ["settle", "release"] }).state).toBe(
      "settle",
    );
  });
});

describe("mandateLink", () => {
  it("leaves off every default, so the plain route is the plain route", () => {
    expect(mandateLink(at)).toBe("/a-intel/core-platform/mandates/mnd_4f2a9c");
  });

  it("carries the search, the facet and the page when they are not the defaults", () => {
    expect(
      mandateLink(at, { search: "pi_3Qa", state: "settle", offset: 25 }),
    ).toBe(
      "/a-intel/core-platform/mandates/mnd_4f2a9c?q=pi_3Qa&state=settle&offset=25",
    );
  });
});

describe("ledgerPage", () => {
  const view = (over: Partial<ReturnType<typeof parseMandateView>> = {}) => ({
    search: null,
    state: null,
    offset: 0,
    ...over,
  });
  const three = [
    mandateMovement({ measure: "amount", externalEffectId: "pi_3QaL8f2Xk" }),
    mandateMovement({
      kind: "reserve",
      measure: "amount",
      externalEffectId: null,
    }),
    mandateMovement({
      kind: "release",
      measure: "calls",
      value: { kind: "count", count: "1", unit: "calls" },
      externalEffectId: null,
    }),
  ];

  it("returns every movement, newest first, on the plain view", () => {
    const page = ledgerPage(three, view());
    expect(page.rows).toEqual(three);
    expect(page).toMatchObject({ total: 3, offset: 0, hasMore: false });
  });

  it("matches a measure and an external effect id, whatever the casing", () => {
    expect(ledgerPage(three, view({ search: "CALLS" })).rows).toHaveLength(1);
    expect(ledgerPage(three, view({ search: "pi_3qa" })).rows).toHaveLength(1);
  });

  it("narrows to one state on the facet", () => {
    expect(ledgerPage(three, view({ state: "release" })).rows).toHaveLength(1);
  });

  it("applies the search and the facet together", () => {
    expect(
      ledgerPage(three, view({ search: "amount", state: "reserve" })).rows,
    ).toHaveLength(1);
    expect(
      ledgerPage(three, view({ search: "calls", state: "reserve" })).rows,
    ).toHaveLength(0);
  });

  it("pages the rows the filter left", () => {
    const many = Array.from({ length: LEDGER_PAGE + 5 }, () =>
      mandateMovement(),
    );
    const first = ledgerPage(many, view());
    expect(first.rows).toHaveLength(LEDGER_PAGE);
    expect(first.hasMore).toBe(true);
    const second = ledgerPage(many, view({ offset: LEDGER_PAGE }));
    expect(second.rows).toHaveLength(5);
    expect(second.hasMore).toBe(false);
  });

  // A blank page would read as a mandate with no movements, and only a link can
  // reach one.
  it("shows the first page rather than nothing when the offset is past the end (negative)", () => {
    const page = ledgerPage(three, view({ offset: 500 }));
    expect(page.rows).toHaveLength(3);
    expect(page.offset).toBe(0);
  });

  it("returns no rows and the true total when nothing matches (negative)", () => {
    const page = ledgerPage(three, view({ search: "no-such-thing" }));
    expect(page.rows).toHaveLength(0);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });
});
