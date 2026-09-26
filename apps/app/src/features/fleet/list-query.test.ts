// Fleet's runs list query on the URL (#3837): parsed from the route's search
// params, turned into the runs read, and written back into the next URL. The
// defaults stay off the URL, and a query the read would refuse is never sent.
import { describe, expect, it } from "vitest";
import { routes } from "@/shared/safe-path";
import {
  DEFAULT_LIST_QUERY,
  effectiveListQuery,
  type FleetListQuery,
  isUnfiltered,
  lastReachablePage,
  listQueryToRoute,
  nextSort,
  pageRange,
  parseListQuery,
  REPLAY_FACET,
  SORTABLE_COLUMNS,
  STATUS_FACET,
  TIER_FACET,
  toRunsListQuery,
  withList,
} from "./list-query";

const list = (over: Partial<FleetListQuery> = {}): FleetListQuery => ({
  ...DEFAULT_LIST_QUERY,
  ...over,
});

describe("parseListQuery", () => {
  it("reads every value the URL carries", () => {
    expect(
      parseListQuery({
        q: "  deploy ",
        status: "sealed,live",
        tier: "observe",
        replay: "not_recorded,fork",
        sort: "cost",
        dir: "asc",
        page: "3",
      }),
    ).toEqual({
      q: "deploy",
      // Each list in its vocabulary's order, whatever order the URL used.
      status: ["live", "sealed"],
      tier: ["observe"],
      replay: ["fork", "not_recorded"],
      sort: "cost",
      dir: "asc",
      page: 3,
    });
  });

  it("drops what this build does not know and keeps the defaults", () => {
    expect(
      parseListQuery({
        status: "parked,paused,live,live",
        tier: "enterprise",
        replay: "",
        sort: "frames",
        dir: "sideways",
        page: "-2",
      }),
    ).toEqual({ ...DEFAULT_LIST_QUERY, status: ["live"] });
    expect(parseListQuery({ page: "1.5" }).page).toBe(1);
    expect(parseListQuery({ page: "abc" }).page).toBe(1);
    expect(parseListQuery({})).toEqual(DEFAULT_LIST_QUERY);
  });

  it("reads the first of a repeated value and caps the search at 200 characters", () => {
    expect(parseListQuery({ q: ["one", "two"] }).q).toBe("one");
    expect(parseListQuery({ q: "x".repeat(250) }).q).toHaveLength(200);
  });
});

describe("the facet vocabularies", () => {
  it("offer the closed vocabularies, with no parked status", () => {
    expect(STATUS_FACET).toEqual(["live", "sealed", "halted"]);
    expect(TIER_FACET).toEqual(["contained", "gateway", "harness", "observe"]);
    expect(REPLAY_FACET).toEqual([
      "inspect",
      "view",
      "fork",
      "retry",
      "not_recorded",
    ]);
  });

  it("sort only the columns the read can order in both stores", () => {
    expect(Object.keys(SORTABLE_COLUMNS).sort()).toEqual([
      "agent",
      "cost",
      "operator",
      "replay",
      "started",
      "status",
      "tier",
    ]);
  });
});

describe("toRunsListQuery", () => {
  const at = { cursor: null, pullRequests: "any" as const, pageSize: 25 };

  it("sends a default list as the page sent it before, and asks for the total", () => {
    expect(toRunsListQuery(DEFAULT_LIST_QUERY, at)).toEqual({
      cursor: null,
      limit: 25,
      pullRequests: "any",
      count: true,
    });
  });

  it("sends the filters, the search, the order and the offset of page N", () => {
    expect(
      toRunsListQuery(
        list({
          q: "deploy",
          status: ["live"],
          tier: ["gateway"],
          replay: ["not_recorded"],
          sort: "operator",
          dir: "desc",
          page: 3,
        }),
        at,
      ),
    ).toEqual({
      cursor: null,
      limit: 25,
      pullRequests: "any",
      status: ["live"],
      tier: ["gateway"],
      replayGrade: ["not_recorded"],
      query: "deploy",
      sort: { key: "operator", dir: "desc" },
      offset: 50,
      count: true,
    });
  });

  it("sends a cursor only on page 1 of the newest-first order", () => {
    expect(toRunsListQuery(list(), { ...at, cursor: "c9" }).cursor).toBe("c9");
    expect(
      toRunsListQuery(list({ page: 2 }), { ...at, cursor: "c9" }).cursor,
    ).toBeNull();
    expect(
      toRunsListQuery(list({ sort: "agent", dir: "asc" }), {
        ...at,
        cursor: "c9",
      }).cursor,
    ).toBeNull();
  });

  it("drops the order and the page under a pull-request filter, which pages by cursor", () => {
    const query = toRunsListQuery(
      list({ sort: "cost", dir: "asc", page: 4, status: ["sealed"] }),
      { ...at, pullRequests: "with", cursor: "c9" },
    );
    expect(query).toEqual({
      cursor: "c9",
      limit: 25,
      pullRequests: "with",
      status: ["sealed"],
      count: true,
    });
  });

  it("stops at the last page an offset can reach", () => {
    expect(lastReachablePage(25)).toBe(401);
    const query = toRunsListQuery(list({ page: 9999 }), at);
    expect(query.offset).toBe(10_000);
  });
});

describe("the route", () => {
  it("round-trips a list through the URL", () => {
    const sorted = list({
      q: "deploy",
      status: ["live", "halted"],
      replay: ["retry"],
      sort: "cost",
      dir: "asc",
      page: 2,
    });
    const path = routes.fleet("acme", "core", listQueryToRoute(sorted, "any"));
    const params = Object.fromEntries(
      new URL(path, "https://app.oxagen.sh").searchParams,
    );
    expect(parseListQuery(params)).toEqual(sorted);
  });

  it("leaves every default off the URL", () => {
    expect(
      routes.fleet("acme", "core", listQueryToRoute(DEFAULT_LIST_QUERY, "any")),
    ).toBe("/acme/core");
  });
});

describe("changing the list", () => {
  it("starts again at page 1", () => {
    expect(withList(list({ page: 5 }), { q: "x" }).page).toBe(1);
  });

  it("cycles a column ascending, descending, then back to newest first", () => {
    const first = nextSort(list({ page: 3 }), "agent");
    expect(first).toMatchObject({ sort: "agent", dir: "asc", page: 1 });
    const second = nextSort(first, "agent");
    expect(second).toMatchObject({ sort: "agent", dir: "desc" });
    expect(nextSort(second, "agent")).toMatchObject({
      sort: "started",
      dir: "desc",
    });
  });

  it("toggles Started between newest and oldest first", () => {
    const oldest = nextSort(list(), "started");
    expect(oldest).toMatchObject({ sort: "started", dir: "asc" });
    expect(nextSort(oldest, "started")).toMatchObject({ dir: "desc" });
  });

  it("serves the order and the page a pull-request filter can page", () => {
    expect(
      effectiveListQuery(list({ sort: "cost", page: 3 }), "without"),
    ).toMatchObject({ sort: "started", dir: "desc", page: 1 });
    expect(effectiveListQuery(list({ page: 3 }), "any").page).toBe(3);
  });

  it("knows an unfiltered list", () => {
    expect(isUnfiltered(list({ sort: "cost", page: 2 }))).toBe(true);
    expect(isUnfiltered(list({ tier: ["observe"] }))).toBe(false);
  });
});

describe("pageRange", () => {
  it("numbers the rows of page N from the offset", () => {
    expect(pageRange(list({ page: 3 }), 25, 25)).toEqual({ from: 51, to: 75 });
    expect(pageRange(list({ page: 2 }), 10, 4)).toEqual({ from: 11, to: 14 });
    expect(pageRange(list(), 25, 0)).toEqual({ from: 0, to: 0 });
  });
});
