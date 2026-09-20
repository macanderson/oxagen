import { describe, expect, it } from "vitest";
import { parseSteeringView, steeringLink } from "./view";

const AT = { org: "acme", ws: "core-platform" };

describe("parseSteeringView", () => {
  it("opens Records, every kind, the first page, nothing selected, for an empty query", () => {
    expect(parseSteeringView({})).toEqual({
      tab: "records",
      kind: null,
      offset: 0,
      proposal: null,
      cursor: null,
    });
  });

  it("reads a kind and an offset on Records", () => {
    expect(parseSteeringView({ kind: "constraint", offset: "50" })).toEqual({
      tab: "records",
      kind: "constraint",
      offset: 50,
      proposal: null,
      cursor: null,
    });
  });

  it("opens Skills with the inventory page the URL names", () => {
    expect(parseSteeringView({ tab: "skills", cursor: "c2" })).toEqual({
      tab: "skills",
      kind: null,
      offset: 0,
      proposal: null,
      cursor: "c2",
    });
  });

  it("opens Settings from its URL without carrying another tab's selection", () => {
    expect(
      parseSteeringView({
        tab: "settings",
        kind: "constraint",
        proposal: "prp_1",
        cursor: "c2",
      }),
    ).toEqual({
      tab: "settings",
      kind: null,
      offset: 0,
      proposal: null,
      cursor: null,
    });
    expect(steeringLink(AT, { tab: "settings" })).toBe(
      "/acme/core-platform/steering?tab=settings",
    );
  });

  it("reads the selected proposal on Context PRs, from the first value of a repeated param", () => {
    expect(
      parseSteeringView({ tab: "prs", proposal: ["prp_01k5ru4a", "prp_x"] }),
    ).toMatchObject({ tab: "prs", proposal: "prp_01k5ru4a" });
  });

  it.each([
    ["an unknown tab", { tab: "effect" }, { tab: "records" }],
    ["an unknown kind", { kind: "directive" }, { kind: null }],
    ["a kind off Records", { tab: "proposals", kind: "rule" }, { kind: null }],
    ["a negative offset", { offset: "-50" }, { offset: 0 }],
    ["a padded offset", { offset: "050" }, { offset: 0 }],
    [
      "an offset past the pages a list holds",
      { offset: "10000000" },
      { offset: 0 },
    ],
    ["a proposal off Context PRs", { proposal: "prp_1" }, { proposal: null }],
    ["a cursor off Skills", { cursor: "c2" }, { cursor: null }],
    ["an empty cursor", { tab: "skills", cursor: "" }, { cursor: null }],
    [
      "a cursor longer than a URL carries",
      { tab: "skills", cursor: "c".repeat(513) },
      { cursor: null },
    ],
    [
      "a malformed proposal",
      { tab: "prs", proposal: "prp_1/../x" },
      { proposal: null },
    ],
    [
      "another kind of id",
      { tab: "prs", proposal: "ctr_1" },
      { proposal: null },
    ],
  ])("falls back for %s (negative)", (_case, params, expected) => {
    expect(parseSteeringView(params)).toMatchObject(expected);
  });
});

describe("steeringLink", () => {
  it("leaves the defaults off the query", () => {
    expect(steeringLink(AT, { tab: "records", kind: null, offset: 0 })).toBe(
      "/acme/core-platform/steering",
    );
  });

  it("carries the tab, the kind, the offset and the proposal", () => {
    expect(steeringLink(AT, { tab: "records", kind: "rule", offset: 50 })).toBe(
      "/acme/core-platform/steering?kind=rule&offset=50",
    );
    expect(steeringLink(AT, { tab: "prs", proposal: "prp_1" })).toBe(
      "/acme/core-platform/steering?tab=prs&proposal=prp_1",
    );
  });
});
