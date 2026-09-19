// Which Tools view a query asks for, and the link back to it: the default
// tab, a value the page does not know, the category chip only on Registry,
// the names toggle, and a cursor whose shape is checked before it goes back
// to the kernel. Also the `measure = value` lines the auto-approval dialog
// writes its ceilings and allow lists in.
import { describe, expect, it } from "vitest";
import {
  parseMeasureLines,
  parseToolsView,
  splitCommas,
  textValue,
  TOOLS_TABS,
  toolsLink,
  weekdayKey,
} from "./view";

const at = { org: "acme", ws: "core-platform" };

describe("parseToolsView", () => {
  it("defaults to the registry on labels, with no category and no cursor", () => {
    expect(parseToolsView({})).toEqual({
      tab: "registry",
      category: null,
      names: "labels",
      cursor: null,
    });
  });

  // The unknown value is one no lane will ever ship, not the name of a tab
  // that has not landed yet: `mandates` stood here until #2957 made it real,
  // and then this case asserted that a live tab was unreachable. A fixture
  // that is only unknown until someone does their job is not a fixture.
  it("takes a tab it knows and falls back to the registry on one it does not", () => {
    for (const tab of TOOLS_TABS) expect(parseToolsView({ tab }).tab).toBe(tab);
    expect(parseToolsView({ tab: "not-a-tab" }).tab).toBe("registry");
    expect(parseToolsView({ tab: "" }).tab).toBe("registry");
    expect(parseToolsView({}).tab).toBe("registry");
  });

  it("reads a consequence tag only on the registry, and only in the contract's shape", () => {
    expect(parseToolsView({ category: "moves_money" }).category).toBe(
      "moves_money",
    );
    expect(parseToolsView({ category: "Moves Money" }).category).toBeNull();
    expect(
      parseToolsView({ tab: "switches", category: "moves_money" }).category,
    ).toBeNull();
  });

  it("takes the API-names toggle and ignores anything else", () => {
    expect(parseToolsView({ names: "api" }).names).toBe("api");
    expect(parseToolsView({ names: "mono" }).names).toBe("labels");
  });

  it("keeps a cursor that looks like one and drops anything else", () => {
    expect(parseToolsView({ cursor: "eyJ2IjoxfQ==" }).cursor).toBe(
      "eyJ2IjoxfQ==",
    );
    expect(parseToolsView({ cursor: "a b" }).cursor).toBeNull();
    expect(parseToolsView({ cursor: "" }).cursor).toBeNull();
  });

  it("takes the first value when a parameter arrives repeated", () => {
    expect(parseToolsView({ tab: ["switches", "registry"] }).tab).toBe(
      "switches",
    );
  });
});

describe("toolsLink", () => {
  it("leaves every default off the query", () => {
    expect(toolsLink(at, { tab: "registry" })).toBe(
      "/acme/core-platform/tools",
    );
    expect(toolsLink(at, { tab: "registry", names: "labels" })).toBe(
      "/acme/core-platform/tools",
    );
  });

  it("carries the tab, the category, the toggle and the cursor", () => {
    expect(
      toolsLink(at, {
        tab: "registry",
        category: "moves_money",
        names: "api",
        cursor: "c2",
      }),
    ).toBe(
      "/acme/core-platform/tools?category=moves_money&names=api&cursor=c2",
    );
    expect(toolsLink(at, { tab: "switches" })).toBe(
      "/acme/core-platform/tools?tab=switches",
    );
    expect(toolsLink(at, { tab: "autoapprovals" })).toBe(
      "/acme/core-platform/tools?tab=autoapprovals",
    );
  });

  it("round-trips through parseToolsView", () => {
    const link = toolsLink(at, { tab: "connections", cursor: "c9" });
    const query = Object.fromEntries(
      new URL(link, "https://mission-control.invalid").searchParams,
    );
    expect(parseToolsView(query)).toEqual({
      tab: "connections",
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
