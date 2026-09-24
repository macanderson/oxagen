// Which Tools view a request asks for, and the link back to it: the tab path
// segment and its aliases (`/tools/servers`, the pre-rev1 `?tab=` values), a
// tab id no longer served, the category chip only on the Tools tab,
// the names toggle, and a cursor whose shape is checked before it goes back
// to the kernel. Also the `measure = value` lines the auto-approval dialog
// writes its ceilings and allow lists in.
import { describe, expect, it } from "vitest";
import {
  carriedBy,
  parseMeasureLines,
  parseToolsTab,
  parseToolsView,
  splitCommas,
  splitLines,
  textValue,
  TOOLS_TABS,
  toolsLink,
  toolsTabOf,
  weekdayKey,
} from "./view";

const at = { org: "acme", ws: "core-platform" };

describe("parseToolsTab", () => {
  it("is Tools on the bare path, and each served tab on its own segment", () => {
    expect(parseToolsTab(undefined, undefined)).toBe("tools");
    expect(parseToolsTab([], undefined)).toBe("tools");
    for (const tab of TOOLS_TABS)
      expect(parseToolsTab([tab], undefined)).toBe(tab);
  });

  it("lands /tools/servers on Providers, the tab that took its name", () => {
    expect(parseToolsTab(["servers"], undefined)).toBe("providers");
    expect(parseToolsTab(undefined, "servers")).toBe("providers");
  });

  it("lands each query tab written before rev1 on the tab that absorbed it", () => {
    expect(parseToolsTab(undefined, "registry")).toBe("tools");
    expect(parseToolsTab(undefined, "connections")).toBe("providers");
    expect(parseToolsTab(undefined, "switches")).toBe("switches");
    expect(parseToolsTab(undefined, "mandates")).toBe("policy");
    expect(parseToolsTab(undefined, "autoapprovals")).toBe("policy");
  });

  // The unknown value is one no lane will ever ship, not the name of a tab
  // that has not landed yet: a fixture that is only unknown until someone
  // does their job is not a fixture.
  it("falls back to Tools on a tab id that is no longer served, so an old link never renders an empty page", () => {
    expect(parseToolsTab(["not-a-tab"], undefined)).toBe("tools");
    expect(parseToolsTab(undefined, "not-a-tab")).toBe("tools");
    expect(parseToolsTab(undefined, "")).toBe("tools");
  });

  it("prefers the path segment over a legacy query", () => {
    expect(parseToolsTab(["policy"], "switches")).toBe("policy");
  });

  it("names no page for a path deeper than one segment (negative)", () => {
    expect(parseToolsTab(["providers", "extra"], undefined)).toBeNull();
  });

  it("reads a raw id the same way toolsTabOf does", () => {
    expect(toolsTabOf(undefined)).toBe("tools");
    expect(toolsTabOf("servers")).toBe("providers");
    expect(toolsTabOf("toolbelts")).toBe("toolbelts");
  });
});

describe("parseToolsView", () => {
  it("defaults to labels, with no category and no cursor", () => {
    expect(parseToolsView("tools", {})).toEqual({
      tab: "tools",
      category: null,
      names: "labels",
      cursor: null,
    });
  });

  it("reads a consequence tag only on the Tools tab, and only in the contract's shape", () => {
    expect(parseToolsView("tools", { category: "moves_money" }).category).toBe(
      "moves_money",
    );
    expect(
      parseToolsView("tools", { category: "Moves Money" }).category,
    ).toBeNull();
    expect(
      parseToolsView("switches", { category: "moves_money" }).category,
    ).toBeNull();
  });

  it("takes the API-names toggle and ignores anything else", () => {
    expect(parseToolsView("tools", { names: "api" }).names).toBe("api");
    expect(parseToolsView("tools", { names: "mono" }).names).toBe("labels");
  });

  it("keeps a cursor that looks like one and drops anything else", () => {
    expect(parseToolsView("tools", { cursor: "eyJ2IjoxfQ==" }).cursor).toBe(
      "eyJ2IjoxfQ==",
    );
    expect(parseToolsView("tools", { cursor: "a b" }).cursor).toBeNull();
    expect(parseToolsView("tools", { cursor: "" }).cursor).toBeNull();
  });

  it("takes the first value when a parameter arrives repeated", () => {
    expect(parseToolsView("tools", { names: ["api", "labels"] }).names).toBe(
      "api",
    );
  });
});

describe("toolsLink", () => {
  it("leaves every default off the path and the query", () => {
    expect(toolsLink(at, { tab: "tools" })).toBe("/acme/core-platform/tools");
    expect(toolsLink(at, { tab: "tools", names: "labels" })).toBe(
      "/acme/core-platform/tools",
    );
  });

  it("puts the tab in the path and the category, toggle and cursor in the query", () => {
    expect(
      toolsLink(at, {
        tab: "tools",
        category: "moves_money",
        names: "api",
        cursor: "c2",
      }),
    ).toBe(
      "/acme/core-platform/tools?category=moves_money&names=api&cursor=c2",
    );
    expect(toolsLink(at, { tab: "switches" })).toBe(
      "/acme/core-platform/tools/switches",
    );
    expect(toolsLink(at, { tab: "policy" })).toBe(
      "/acme/core-platform/tools/policy",
    );
  });

  it("round-trips through parseToolsTab and parseToolsView", () => {
    const link = toolsLink(at, { tab: "providers", cursor: "c9" });
    const url = new URL(link, "https://mission-control.invalid");
    const segments = url.pathname.split("/").slice(4);
    const tab = parseToolsTab(segments, undefined);
    expect(tab).toBe("providers");
    expect(
      parseToolsView("providers", Object.fromEntries(url.searchParams)),
    ).toEqual({
      tab: "providers",
      category: null,
      names: "labels",
      cursor: "c9",
    });
  });
});

describe("textValue", () => {
  it("returns the field's text, and the empty string for a field the form does not carry", () => {
    const form = new FormData();
    form.set("reason", "rotation confirmed");
    expect(textValue(form, "reason")).toBe("rotation confirmed");
    expect(textValue(form, "missing")).toBe("");
  });

  it("returns the empty string for a field that is not text", () => {
    const form = new FormData();
    form.set("file", new Blob(["x"]), "x.txt");
    expect(textValue(form, "file")).toBe("");
  });
});

describe("parseMeasureLines", () => {
  it("reads one measure per line, trimmed, blank lines dropped, in order", () => {
    expect(
      parseMeasureLines(" amount = 50000000 \n\n recipients=10\r\n"),
    ).toEqual([
      ["amount", "50000000"],
      ["recipients", "10"],
    ]);
    expect(parseMeasureLines("")).toEqual([]);
  });

  it("keeps everything after the first equals sign as the value", () => {
    expect(parseMeasureLines("counterparty = cus_*, vendor:aws")).toEqual([
      ["counterparty", "cus_*, vendor:aws"],
    ]);
  });

  // A line the dialog cannot read refuses the whole draft. Dropping it would
  // save a rule without a ceiling the person wrote, which releases more calls.
  it.each([
    ["no equals sign", "amount 500"],
    ["no measure", "= 500"],
    ["no value", "amount ="],
    ["a measure named twice", "amount = 1\namount = 2"],
  ])("refuses %s", (_what, raw) => {
    expect(parseMeasureLines(raw)).toBeNull();
  });
});

describe("splitCommas", () => {
  it("splits on commas alone, trimmed, blanks dropped, each value once", () => {
    expect(splitCommas(" cus_* , vendor:aws ,, cus_* ")).toEqual([
      "cus_*",
      "vendor:aws",
    ]);
    expect(splitCommas("   ")).toEqual([]);
  });

  // A glob is `z.string().min(1).max(256)`, so a space is inside one value.
  // Splitting on it would leave `vendor:*`, which admits every vendor target.
  it("keeps a glob that contains whitespace whole", () => {
    expect(splitCommas("vendor:* prod, cus_*")).toEqual([
      "vendor:* prod",
      "cus_*",
    ]);
  });
});

describe("carriedBy", () => {
  it("is true when the field would write the stored list back as it is", () => {
    expect(carriedBy(["cus_*", "vendor:* prod"], ", ", splitCommas)).toBe(true);
    expect(carriedBy(["a@*", "b c@1"], "\n", splitLines)).toBe(true);
    expect(carriedBy([], ", ", splitCommas)).toBe(true);
  });

  // The delimiter inside one legal value is the one thing a delimited field
  // cannot show: `vendor:*,prod` reads back as `vendor:*` and `prod` (negative).
  it("is false when a value contains the field's delimiter", () => {
    expect(carriedBy(["vendor:*,prod"], ", ", splitCommas)).toBe(false);
    expect(carriedBy(["stripe__a@*\nstripe__b@*"], "\n", splitLines)).toBe(
      false,
    );
  });

  it("is false when the field would drop or reorder a value (negative)", () => {
    expect(carriedBy([" cus_*"], ", ", splitCommas)).toBe(false);
    expect(carriedBy(["cus_*", "cus_*"], ", ", splitCommas)).toBe(false);
  });
});

describe("weekdayKey", () => {
  it("keys ISO weekdays Monday first, as the catalogue holds them", () => {
    const keys = ["1", "2", "3", "4", "5", "6", "7"];
    expect([1, 2, 3, 4, 5, 6, 7].map(weekdayKey)).toEqual(keys);
  });

  // The contract bounds a rule's days to 1 to 7, so anything else is a bug
  // upstream, and a thrown error names it rather than printing a raw key.
  it.each([0, 8, 1.5])("refuses %s", (day) => {
    expect(() => weekdayKey(day)).toThrow(RangeError);
  });
});
