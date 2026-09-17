// Which Tools view a query asks for, and the link back to it: the default
// tab, a value the page does not know, the category chip only on Registry,
// the names toggle, and a cursor whose shape is checked before it goes back
// to the kernel.
import { describe, expect, it } from "vitest";
import { parseToolsView, textValue, TOOLS_TABS, toolsLink } from "./view";

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
