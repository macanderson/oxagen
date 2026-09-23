// Which Steering view an address resolves to (roadmap pages/steering.md):
// every tab and shelf as a path segment, every address written before the
// five tabs landing where it lives now, the query values each view keeps,
// and a 404 for a segment that names nothing.
import { describe, expect, it } from "vitest";
import { resolveSteeringRoute, shelfLink, steeringLink } from "./view";

const AT = { org: "acme", ws: "core" };
const BASE = "/acme/core/steering";
const resolve = (segments?: string[], query: Record<string, string> = {}) =>
  resolveSteeringRoute(AT, segments, query);

describe("resolveSteeringRoute", () => {
  it("opens the Library's All shelf on the bare route and on /library", () => {
    for (const segments of [undefined, ["library"]]) {
      expect(resolve(segments)).toEqual({
        kind: "view",
        view: {
          tab: "library",
          shelf: "all",
          segment: null,
          agent: null,
          kind: null,
          offset: 0,
          proposal: null,
          cursor: null,
          skillView: undefined,
          skill: null,
        },
      });
    }
  });

  it.each(["records", "instructions", "skills", "memory", "ontology"])(
    "lands /%s on the Library with that shelf",
    (shelf) => {
      expect(resolve([shelf])).toMatchObject({
        kind: "view",
        view: { tab: "library", shelf },
      });
    },
  );

  it.each(["assignments", "gates", "proposals", "compiler"])(
    "opens /%s as its own tab with no shelf",
    (tab) => {
      expect(resolve([tab])).toMatchObject({
        kind: "view",
        view: { tab, shelf: null },
      });
    },
  );

  it("keeps the kind and the page on Records, and drops a kind it does not know", () => {
    expect(resolve(["records"], { kind: "rule", offset: "50" })).toMatchObject({
      view: { shelf: "records", kind: "rule", offset: 50 },
    });
    expect(resolve(["records"], { kind: "wish" })).toMatchObject({
      view: { kind: null },
    });
    expect(resolve(["library"], { kind: "rule" })).toMatchObject({
      view: { kind: null },
    });
  });

  it("opens the Context PRs segment with the proposal it selects, and ignores a malformed id (negative)", () => {
    expect(
      resolve(["proposals", "prs"], { proposal: "prp_01k5ru4a" }),
    ).toMatchObject({
      view: { tab: "proposals", segment: "prs", proposal: "prp_01k5ru4a" },
    });
    expect(
      resolve(["proposals", "prs"], { proposal: "prp_1;drop" }),
    ).toMatchObject({ view: { proposal: null } });
    expect(resolve(["proposals"], { proposal: "prp_01k5ru4a" })).toMatchObject({
      view: { segment: "candidates", proposal: null },
    });
  });

  it("names the Compiler's agent from its segment", () => {
    expect(resolve(["compiler", "release-manager"])).toMatchObject({
      view: { tab: "compiler", agent: "release-manager" },
    });
  });

  it("reads the Skills shelf's view and cursor, and its source address", () => {
    expect(resolve(["skills"], { cursor: "c2" })).toMatchObject({
      view: { shelf: "skills", cursor: "c2" },
    });
    expect(resolve(["skills", "search"])).toMatchObject({
      view: { shelf: "skills", skillView: "search" },
    });
    expect(
      resolve(["skills", "a-intel.release-notes-from-prs", "source"]),
    ).toMatchObject({
      view: {
        shelf: "skills",
        skillView: "source",
        skill: "a-intel.release-notes-from-prs",
      },
    });
    // The id belongs to the source view alone.
    expect(resolve(["skills", "search"])).toMatchObject({
      view: { skill: null },
    });
  });

  it("builds the skill source address from the id it carries", () => {
    expect(
      steeringLink(AT, { tab: "skills", skill: "a-intel.release-notes" }),
    ).toBe(`${BASE}/skills/a-intel.release-notes/source`);
  });

  it.each<[string[] | undefined, Record<string, string>, string]>([
    [["policy"], {}, `${BASE}/gates`],
    [["settings"], {}, `${BASE}/gates`],
    [["freshness"], {}, `${BASE}/gates`],
    [["deliveries"], {}, `${BASE}/assignments`],
    [["prs"], { proposal: "prp_1" }, `${BASE}/proposals/prs?proposal=prp_1`],
    [["preview"], {}, `${BASE}/compiler`],
    [["preview", "release-manager"], {}, `${BASE}/compiler/release-manager`],
    [["library", "all"], {}, `${BASE}/library`],
    [["library", "records"], { kind: "rule" }, `${BASE}/records?kind=rule`],
    [["library", "skills"], {}, `${BASE}/skills`],
    [undefined, { tab: "records", kind: "fact" }, `${BASE}/records?kind=fact`],
    [undefined, { tab: "skills", cursor: "c2" }, `${BASE}/skills?cursor=c2`],
    [
      undefined,
      { tab: "prs", proposal: "prp_1" },
      `${BASE}/proposals/prs?proposal=prp_1`,
    ],
    [undefined, { tab: "settings" }, `${BASE}/gates`],
    [undefined, { tab: "deliveries" }, `${BASE}/assignments`],
    [undefined, { tab: "memory" }, `${BASE}/memory`],
  ])("moves an old address %o %o to %s", (segments, query, to) => {
    expect(resolve(segments, query)).toEqual({ kind: "redirect", to });
  });

  it("keeps the bare route for a ?tab= it does not know (negative)", () => {
    expect(resolve(undefined, { tab: "effect" })).toMatchObject({
      kind: "view",
      view: { tab: "library", shelf: "all" },
    });
    expect(resolve(undefined, { tab: "constructor" })).toMatchObject({
      kind: "view",
    });
  });

  it.each([
    [["nowhere"]],
    [["records", "extra"]],
    [["gates", "x"]],
    [["proposals", "candidates"]],
    [["compiler", "a b"]],
    [["compiler", "a", "b"]],
    [["library", "bogus"]],
    [["library", "records", "x"]],
    [["skills", "bogus"]],
    [["skills", "id", "other"]],
    [["policy", "x"]],
    [["constructor"]],
    [["a", "b", "c", "d"]],
  ])("answers %o with a 404 (negative)", (segments) => {
    expect(resolve(segments)).toEqual({ kind: "not_found" });
  });
});

describe("links", () => {
  it("builds each tab's and shelf's path, leaving the defaults off", () => {
    expect(steeringLink(AT, { tab: "library" })).toBe(`${BASE}/library`);
    expect(steeringLink(AT, { tab: "records", kind: "rule", offset: 0 })).toBe(
      `${BASE}/records?kind=rule`,
    );
    expect(steeringLink(AT, { tab: "proposals", offset: 50 })).toBe(
      `${BASE}/proposals?offset=50`,
    );
  });
  it("gives steering delivery its own section and keeps the legacy link", () => {
    expect(parseSteeringView({ tab: "deliveries" })).toMatchObject({
      tab: "deliveries",
    });
    expect(steeringLink(AT, { tab: "deliveries" })).toBe(
      "/acme/core-platform/steering/deliveries",
    );
  });
  it("gives path selectors priority over conflicting legacy queries", () => {
    expect(
      steeringLink(AT, { tab: "compiler", agent: "release-manager" }),
    ).toBe(`${BASE}/compiler/release-manager`);
    expect(shelfLink(AT, "all")).toBe(`${BASE}/library`);
    expect(shelfLink(AT, "ontology")).toBe(`${BASE}/ontology`);
  });
});
