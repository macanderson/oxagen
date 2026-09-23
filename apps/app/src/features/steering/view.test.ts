import { describe, expect, it } from "vitest";
import { parseSteeringView, steeringLink, steeringPathParams } from "./view";
const AT = { org: "acme", ws: "core-platform" };

describe("Steering routes", () => {
  it("opens the whole Library by default", () => {
    expect(parseSteeringView({})).toEqual({
      tab: "library",
      shelf: "all",
      kind: null,
      offset: 0,
      proposal: null,
      cursor: null,
      section: "candidates",
    });
  });
  it.each([
    ["records", "library", "records"],
    ["skills", "library", "skills"],
    ["memory", "library", "memory"],
    ["settings", "freshness", "all"],
    ["prs", "proposals", "all"],
  ])("keeps the meaning of the legacy %s link", (legacy, tab, shelf) => {
    expect(parseSteeringView({ tab: legacy })).toMatchObject({ tab, shelf });
  });
  it("retains inventory cursors, record kinds and selected PRs on their sections", () => {
    expect(parseSteeringView({ tab: "skills", cursor: "c2" })).toMatchObject({
      cursor: "c2",
    });
    expect(
      parseSteeringView({ kind: "constraint", offset: "50" }),
    ).toMatchObject({ shelf: "records", kind: "constraint", offset: 50 });
    expect(
      parseSteeringView({ tab: "prs", proposal: ["prp_1", "prp_2"] }),
    ).toMatchObject({ section: "prs", proposal: "prp_1" });
  });
  it.each([
    [{ tab: "unknown" }, { tab: "library" }],
    [{ tab: "__proto__" }, { tab: "library" }],
    [{ tab: "library", shelf: "unknown" }, { shelf: "all" }],
    [
      { tab: "freshness", kind: "rule", proposal: "prp_1", cursor: "c2" },
      { kind: null, proposal: null, cursor: null },
    ],
    [{ offset: "050" }, { offset: 0 }],
    [{ offset: "-1" }, { offset: 0 }],
    [{ tab: "prs", proposal: "prp_1/../x" }, { proposal: null }],
    [{ tab: "skills", cursor: "c".repeat(513) }, { cursor: null }],
  ])("rejects invalid or unrelated selections", (query, expected) => {
    expect(parseSteeringView(query)).toMatchObject(expected);
  });
  it("uses path sections and preserves query filters", () => {
    expect(steeringLink(AT, { tab: "records", kind: "rule", offset: 50 })).toBe(
      "/acme/core-platform/steering/library/records?kind=rule&offset=50",
    );
    expect(steeringLink(AT, { tab: "prs", proposal: "prp_1" })).toBe(
      "/acme/core-platform/steering/proposals?proposal=prp_1&section=prs",
    );
    expect(
      steeringLink(AT, { tab: "skills", cursor: "next", view: "search" }),
    ).toBe(
      "/acme/core-platform/steering/library/skills?cursor=next&view=search",
    );
  });
  it("gives path selectors priority over conflicting legacy queries", () => {
    expect(
      parseSteeringView(
        steeringPathParams(["library", "skills"], {
          tab: "freshness",
          shelf: "records",
          cursor: "next",
        }),
      ),
    ).toMatchObject({ tab: "library", shelf: "skills", cursor: "next" });
  });
});
