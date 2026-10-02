// Which Steering view an address resolves to (roadmap pages/steering.md):
// every tab and shelf as a path segment, every address written before the
// five tabs landing where it lives now, the query values each view keeps,
// and a 404 for a segment that names nothing.
import { describe, expect, it } from "vitest";
import {
  resolveSteeringRoute,
  shelfLink,
  skillRowsParam,
  steeringLink,
} from "./view";

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
          state: null,
          agent: null,
          kind: null,
          offset: 0,
          rows: 50,
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

  // #5077: the list shows open proposals unless the URL names another state.
  it("reads the Proposals state from the URL, open by default and for a state it does not offer (negative)", () => {
    expect(resolve(["proposals"])).toMatchObject({
      view: { tab: "proposals", state: "open" },
    });
    for (const state of ["open", "merged", "closed"] as const) {
      expect(resolve(["proposals"], { state })).toMatchObject({
        view: { state },
      });
    }
    expect(resolve(["proposals"], { state: "rejected" })).toMatchObject({
      view: { state: "open" },
    });
    expect(resolve(["records"], { state: "merged" })).toMatchObject({
      view: { state: null },
    });
  });

  it("moves the Context PRs segment to the list, and a selected proposal to its own page", () => {
    expect(resolve(["proposals", "prs"], { state: "merged" })).toEqual({
      kind: "redirect",
      to: `${BASE}/proposals?state=merged`,
    });
    expect(
      resolve(["proposals", "prs"], {
        proposal: "prp_01k5ru4a",
        state: "closed",
      }),
    ).toEqual({
      kind: "redirect",
      to: `${BASE}/proposals/prs/prp_01k5ru4a?state=closed`,
    });
    expect(resolve(["proposals"], { proposal: "prp_01k5ru4a" })).toEqual({
      kind: "redirect",
      to: `${BASE}/proposals/prs/prp_01k5ru4a`,
    });
    // A malformed id selects nothing, and the list does not carry it.
    expect(resolve(["proposals", "prs"], { proposal: "prp_1;drop" })).toEqual({
      kind: "redirect",
      to: `${BASE}/proposals`,
    });
    expect(resolve(["proposals"], { proposal: "prp_1;drop" })).toMatchObject({
      kind: "view",
      view: { tab: "proposals" },
    });
  });

  // #4693: Rows per page sits under the Proposals list.
  it("reads the size Rows per page picked on the Proposals list", () => {
    for (const rows of [10, 25, 50, 100]) {
      expect(resolve(["proposals"], { rows: String(rows) })).toMatchObject({
        view: { tab: "proposals", rows },
      });
    }
    expect(
      resolve(["proposals"], { rows: "10", offset: "20" }),
    ).toMatchObject({ view: { rows: 10, offset: 20 } });
  });

  it("reads a size Rows does not offer, or a size off Proposals, as 50 (negative)", () => {
    for (const rows of ["0", "7", "200", "-10", "many", ""]) {
      expect(resolve(["proposals"], { rows })).toMatchObject({
        view: { rows: 50 },
      });
    }
    expect(resolve(["records"], { rows: "10" })).toMatchObject({
      view: { rows: 50 },
    });
  });

  it("reads the size Rows per page picked under the skill inventory, 100 by default (#4693)", () => {
    expect(resolve(["skills"])).toMatchObject({ view: { rows: 100 } });
    for (const rows of [10, 25, 50, 100]) {
      expect(resolve(["skills"], { rows: String(rows) })).toMatchObject({
        view: { shelf: "skills", rows },
      });
    }
    expect(
      resolve(["skills"], { rows: "25", cursor: "c2" }),
    ).toMatchObject({ view: { rows: 25, cursor: "c2" } });
  });

  it("reads a size the skill inventory does not offer as 100 (negative)", () => {
    for (const rows of ["0", "7", "200", "-10", "many", ""]) {
      expect(resolve(["skills"], { rows })).toMatchObject({
        view: { rows: 100 },
      });
    }
  });

  it("leaves the skill inventory's default size off the address and writes any other", () => {
    expect(skillRowsParam(100)).toBeUndefined();
    for (const rows of [10, 25, 50]) {
      expect(skillRowsParam(rows)).toBe(String(rows));
    }
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
    [["prs"], { proposal: "prp_1" }, `${BASE}/proposals/prs/prp_1`],
    [
      ["prs"],
      { rows: "25", offset: "25" },
      `${BASE}/proposals?rows=25&offset=25`,
    ],
    [["proposals", "prs"], {}, `${BASE}/proposals`],
    [["preview"], {}, `${BASE}/compiler`],
    [["preview", "release-manager"], {}, `${BASE}/compiler/release-manager`],
    [["library", "all"], {}, `${BASE}/library`],
    [["library", "records"], { kind: "rule" }, `${BASE}/records?kind=rule`],
    [["library", "skills"], {}, `${BASE}/skills`],
    [undefined, { tab: "records", kind: "fact" }, `${BASE}/records?kind=fact`],
    [undefined, { tab: "skills", cursor: "c2" }, `${BASE}/skills?cursor=c2`],
    [undefined, { tab: "prs", proposal: "prp_1" }, `${BASE}/proposals/prs/prp_1`],
    [undefined, { tab: "prs", state: "merged" }, `${BASE}/proposals?state=merged`],
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
    [["proposals", "prs", "prp_1", "x"]],
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
    expect(steeringLink(AT, { tab: "proposals", rows: 50, offset: 50 })).toBe(
      `${BASE}/proposals?offset=50`,
    );
    expect(steeringLink(AT, { tab: "deliveries" })).toBe(`${BASE}/assignments`);
    expect(
      steeringLink(AT, { tab: "compiler", agent: "release-manager" }),
    ).toBe(`${BASE}/compiler/release-manager`);
    expect(shelfLink(AT, "all")).toBe(`${BASE}/library`);
    expect(shelfLink(AT, "ontology")).toBe(`${BASE}/ontology`);
  });

  it("carries a size other than 50, before the offset", () => {
    expect(steeringLink(AT, { tab: "proposals", rows: 25, offset: 50 })).toBe(
      `${BASE}/proposals?rows=25&offset=50`,
    );
    expect(steeringLink(AT, { tab: "prs", rows: 10 })).toBe(
      `${BASE}/proposals?rows=10`,
    );
  });

  it("carries the Proposals state, leaving open, the default, off (#5077)", () => {
    expect(steeringLink(AT, { tab: "proposals", state: "open" })).toBe(
      `${BASE}/proposals`,
    );
    expect(
      steeringLink(AT, { tab: "proposals", state: "merged", rows: 25 }),
    ).toBe(`${BASE}/proposals?state=merged&rows=25`);
  });
});
