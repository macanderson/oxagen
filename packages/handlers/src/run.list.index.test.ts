// The run index behind list_runs's filters, search, sort, offset and total
// (#3837). The SQL is read from drizzle's own rendering, as run.list.test.ts
// reads the keyset page's: each filter, the search and its escaping, both sort
// directions with nulls last, the bounded count, and the tenant fence on both
// branches. The page assembly and the total run over fakes.
import { schema } from "@oxagen/database";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  RUN_LIST_TOTAL_BOUND,
  runList,
  type RunListInput,
} from "@oxagen/oxagen/contracts/run.list";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";
import {
  countRuns,
  escapeLike,
  isNewestFirst,
  NEWEST_FIRST,
  readRunIndexPage,
  refuseRunIndexInput,
  type RunIndexDeps,
  type RunIndexRequest,
  runIndexCountQueries,
  runIndexOrder,
  runIndexPageQuery,
  runIndexRequest,
  totalOf,
  usesRunIndex,
} from "./run.list.index";
import { ledgerRun, SCOPE, tachoSession } from "./run.test-support";

const db = drizzle.mock({ schema });

/** The input as the contract parses it, so defaults apply as in production. */
const input = (over: Partial<RunListInput> = {}): RunListInput =>
  runList.input.parse(over);

const request = (over: Partial<RunIndexRequest> = {}): RunIndexRequest => ({
  order: NEWEST_FIRST,
  cursor: null,
  offset: 0,
  limit: 25,
  withoutWitnessRuns: false,
  sessionsOnly: false,
  ...over,
});

const pageSql = (over: Partial<RunIndexRequest> = {}) =>
  runIndexPageQuery(db, SCOPE, request(over)).toSQL();

/** The SQL between two markers, so an assertion reads one branch alone. */
function branches(sql: string): { ledger: string; tacho: string } {
  const split = sql.indexOf("union all");
  expect(split).toBeGreaterThan(0);
  return { ledger: sql.slice(0, split), tacho: sql.slice(split) };
}

describe("usesRunIndex", () => {
  it("leaves an input with no filter, search, order or offset on the keyset page", () => {
    expect(usesRunIndex(input())).toBe(false);
    expect(usesRunIndex(input({ offset: 0 }))).toBe(false);
    expect(usesRunIndex(input({ sort: { key: "started", dir: "desc" } }))).toBe(
      false,
    );
    expect(usesRunIndex(input({ pullRequests: "with" }))).toBe(false);
  });

  it.each<[string, Partial<RunListInput>]>([
    ["status", { status: ["live"] }],
    ["tier", { tier: ["gateway"] }],
    ["replayGrade", { replayGrade: ["not_recorded"] }],
    ["query", { query: "deploy" }],
    ["an ascending start", { sort: { key: "started", dir: "asc" } }],
    ["another column", { sort: { key: "cost", dir: "desc" } }],
    ["an offset", { offset: 25 }],
  ])("sends %s to the index", (_label, over) => {
    expect(usesRunIndex(input(over))).toBe(true);
  });
});

describe("refuseRunIndexInput", () => {
  const codeOf = (over: Partial<RunListInput>): string | null => {
    try {
      refuseRunIndexInput(runList.name, input(over));
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe("invalid_input");
      return (err as CapabilityError).message;
    }
  };

  it("refuses a cursor with an offset, even an offset of 0", () => {
    expect(codeOf({ cursor: "abc", offset: 0 })).toBe("cursor_with_offset");
    expect(codeOf({ cursor: "abc", offset: 50 })).toBe("cursor_with_offset");
  });

  it("refuses a cursor with any order but newest first", () => {
    expect(codeOf({ cursor: "abc", sort: { key: "cost", dir: "desc" } })).toBe(
      "cursor_with_sort",
    );
    expect(
      codeOf({ cursor: "abc", sort: { key: "started", dir: "asc" } }),
    ).toBe("cursor_with_sort");
    expect(
      codeOf({ cursor: "abc", sort: { key: "started", dir: "desc" } }),
    ).toBeNull();
  });

  it("refuses a pull-request filter with an offset past the first row or another order", () => {
    expect(codeOf({ pullRequests: "with", offset: 25 })).toBe(
      "pull_requests_with_offset",
    );
    expect(
      codeOf({ pullRequests: "without", sort: { key: "agent", dir: "asc" } }),
    ).toBe("pull_requests_with_sort");
    expect(codeOf({ pullRequests: "any", offset: 25 })).toBeNull();
  });

  it("admits a cursor or a pull-request filter beside the filters and the search", () => {
    expect(
      codeOf({ cursor: "abc", status: ["live"], query: "deploy" }),
    ).toBeNull();
    expect(
      codeOf({ pullRequests: "with", tier: ["observe"], offset: 0 }),
    ).toBeNull();
  });
});

describe("escapeLike", () => {
  it("escapes the two wildcards and the escape character", () => {
    expect(escapeLike("50%_off\\now")).toBe("50\\%\\_off\\\\now");
    expect(escapeLike("plain text")).toBe("plain text");
  });
});

describe("runIndexRequest", () => {
  const at = { cursor: null, limit: 25, withoutWitnessRuns: false };

  it("skips the offset on the first read only", () => {
    expect(runIndexRequest(input({ offset: 50 }), at).offset).toBe(50);
    expect(
      runIndexRequest(input({ offset: 50 }), {
        ...at,
        cursor: { at: "2026-09-11T10:00:00.000Z", id: "tse_a" },
      }).offset,
    ).toBe(0);
  });

  it("lists sessions only under a pull-request filter and reads newest first by default", () => {
    const req = runIndexRequest(input({ pullRequests: "without" }), at);
    expect(req.sessionsOnly).toBe(true);
    expect(req.order).toEqual(NEWEST_FIRST);
    expect(runIndexRequest(input(), at).sessionsOnly).toBe(false);
  });
});

describe("the index page query", () => {
  it("names the tenant in both branches", () => {
    const { sql, params } = pageSql();
    const { ledger, tacho } = branches(sql);
    for (const branch of [ledger, tacho]) {
      expect(branch).toMatch(/"org_id" = \$\d+/);
      expect(branch).toMatch(/"workspace_id" = \$\d+/);
    }
    expect(params).toContain(SCOPE.orgId);
    expect(params).toContain(SCOPE.workspaceId);
  });

  it("lists V2 ledger runs without the in-app agent's surfaces, and root sessions only", () => {
    const { sql, params } = pageSql();
    const { ledger, tacho } = branches(sql);
    expect(ledger).toContain('"spec_version" = $');
    expect(ledger).toContain('"surface" not in (');
    expect(params).toEqual(expect.arrayContaining(["chat", "api-chat"]));
    expect(tacho).toContain('"parent_session_uuid" is null');
  });

  it("reads wrapped sessions alone under a pull-request filter", () => {
    const { sql } = pageSql({ sessionsOnly: true });
    expect(sql).not.toContain("union all");
    expect(sql).not.toContain('"agent_runs"');
    expect(sql).toContain('"tacho"."sessions"');
  });

  it("filters status through each store's own words", () => {
    const { sql, params } = pageSql({ status: ["live"] });
    const { ledger, tacho } = branches(sql);
    expect(ledger).toMatch(/"agent_runs"\."status" in \(\$\d+, \$\d+\)/);
    expect(tacho).toMatch(/"sessions"\."outcome" in \(\$\d+\)/);
    // A live ledger run is pending or running; a live session is running.
    expect(params).toEqual(expect.arrayContaining(["pending", "running"]));
    expect(params).not.toContain("completed");
  });

  it("filters halted runs to a ledger cancel and a session abort", () => {
    const { params } = pageSql({ status: ["halted"] });
    expect(params).toEqual(expect.arrayContaining(["cancelled", "aborted"]));
    expect(params).not.toContain("pending");
  });

  it("filters the tier as published, a ledger run with no graded seal reading harness", () => {
    const { sql, params } = pageSql({ tier: ["harness"] });
    const { ledger, tacho } = branches(sql);
    expect(ledger).toContain("left join lateral");
    expect(ledger).toContain('"latest_seal"."enforcement_tier"');
    expect(ledger).toContain("else 'harness' end");
    expect(tacho).toContain('"sessions"."enforcement_tier"');
    expect(tacho).toContain("else 'harness' end");
    expect(params.filter((p) => p === "harness").length).toBeGreaterThan(2);
  });

  it("filters a replay grade, and not_recorded as a null grade", () => {
    const graded = pageSql({ replayGrade: ["fork"] });
    expect(graded.params).toContain("fork");
    expect(graded.sql).not.toMatch(/is null\)/);

    const none = pageSql({ replayGrade: ["not_recorded"] });
    const { ledger, tacho } = branches(none.sql);
    // A live ledger run reads no grade whatever an earlier seal said.
    expect(ledger).toContain("then null else");
    expect(ledger).toMatch(/end\) is null/);
    expect(tacho).toMatch(/end\) is null/);

    const either = pageSql({ replayGrade: ["retry", "not_recorded"] });
    expect(either.params).toContain("retry");
    expect(either.sql).toMatch(/ or \(case when .* end\) is null/);
  });

  it("searches every named column in both stores, with the wildcards escaped", () => {
    const { sql, params } = pageSql({ query: "50%_off" });
    const { ledger, tacho } = branches(sql);
    const pattern = "%50\\%\\_off%";
    expect(params.filter((p) => p === pattern).length).toBe(14);
    for (const column of [
      '"agent_runs"."public_id" ilike',
      '"agent_runs"."name" ilike',
      "->>'goal' ilike",
      '"organizations"."namespace"',
      '"users"."display_name"',
    ])
      expect(ledger).toContain(column);
    for (const column of [
      '"sessions"."public_id" ilike',
      '"sessions"."harness_title" ilike',
      '"sessions"."name" ilike',
      '"sessions"."title" ilike',
      '"sessions"."agent_key" ilike',
      '"sessions"."model_initial" ilike',
      '"sessions"."model_final" ilike',
      '"hosts"."hostname" ilike',
    ])
      expect(tacho).toContain(column);
  });

  it("orders newest first by default, ties on public id byte-wise", () => {
    const { sql } = pageSql();
    expect(sql).toMatch(/order by "started_at" desc, "public_id" desc/);
    expect(sql).toContain('collate "C" as "public_id"');
  });

  it("orders oldest first when asked", () => {
    const { sql } = pageSql({ order: { key: "started", dir: "asc" } });
    expect(sql).toMatch(/order by "started_at" asc, "public_id" asc/);
  });

  it.each(["asc", "desc"] as const)(
    "sorts a column %s with nulls last, then newest first",
    (dir) => {
      const { sql } = pageSql({ order: { key: "agent", dir } });
      expect(sql).toMatch(
        new RegExp(
          `order by "sort_value" ${dir} nulls last, "started_at" desc, "public_id" desc`,
        ),
      );
      expect(sql).toContain("lower(");
    },
  );

  it("sorts the tier and the grade along their ladders, not alphabetically", () => {
    const tier = pageSql({ order: { key: "tier", dir: "asc" } });
    expect(tier.sql).toContain("array_position(array[");
    expect(tier.params).toEqual(
      expect.arrayContaining(["contained", "gateway", "harness", "observe"]),
    );
    const replay = pageSql({ order: { key: "replay", dir: "desc" } });
    expect(replay.params).toEqual(
      expect.arrayContaining(["inspect", "view", "fork", "retry"]),
    );
  });

  it("sorts status by the lifecycle words in the contract's order", () => {
    const { sql } = pageSql({ order: { key: "status", dir: "asc" } });
    expect(sql).toMatch(/then 0 when .* then 1 when .* then 2 end/);
  });

  it("sorts cost by the priced figure, falling back to what a session reported", () => {
    const { sql } = pageSql({ order: { key: "cost", dir: "desc" } });
    const { ledger, tacho } = branches(sql);
    for (const branch of [ledger, tacho]) {
      expect(branch).toContain('left join "cost"."run_totals"');
      expect(branch).toContain('"run_totals"."cost_basis" is not null');
    }
    expect(tacho).toContain('"sessions"."total_cost_micros"');
    expect(sql).toContain("::bigint");
  });

  it("reads one row past the page, from the offset", () => {
    const { sql, params } = pageSql({ limit: 25, offset: 50 });
    expect(sql).toMatch(/limit \$\d+ offset \$\d+$/);
    expect(params.slice(-2)).toEqual([26, 50]);
  });

  it("carries on after a cursor in both branches", () => {
    const cursor = { at: "2026-09-11T10:00:00.000Z", id: "tse_b" };
    const { sql, params } = pageSql({ cursor });
    const { ledger, tacho } = branches(sql);
    for (const branch of [ledger, tacho]) {
      expect(branch).toContain("::timestamptz");
      expect(branch).toContain('collate "C" < $');
    }
    expect(params.filter((p) => p === cursor.id).length).toBe(2);
  });

  it("leaves witness runs out of both branches only when asked", () => {
    const hidden = branches(pageSql({ withoutWitnessRuns: true }).sql);
    expect(hidden.ledger).toContain('"evidence"."verdicts"');
    expect(hidden.tacho).toContain('"evidence"."verdicts"');
    expect(pageSql().sql).not.toContain('"evidence"."verdicts"');
  });
});

describe("the count queries", () => {
  it("count each store to one past the bound, with the filters and no order", () => {
    const queries = runIndexCountQueries(
      db,
      SCOPE,
      request({
        status: ["sealed"],
        query: "deploy",
        order: { key: "cost", dir: "asc" },
        offset: 75,
        cursor: { at: "2026-09-11T10:00:00.000Z", id: "tse_b" },
      }),
    );
    const ledger = queries.ledger?.toSQL();
    const tacho = queries.tacho.toSQL();
    for (const query of [ledger, tacho]) {
      expect(query?.sql).toMatch(/^select count\(\*\)::int from \(select/);
      expect(query?.params).toContain(RUN_LIST_TOTAL_BOUND + 1);
      expect(query?.params).toContain("%deploy%");
      expect(query?.params).toContain(SCOPE.workspaceId);
      expect(query?.sql).not.toContain("offset");
      expect(query?.sql).not.toContain("::timestamptz");
    }
  });

  it("counts wrapped sessions alone under a pull-request filter", () => {
    expect(
      runIndexCountQueries(db, SCOPE, request({ sessionsOnly: true })).ledger,
    ).toBeNull();
  });
});

describe("runIndexOrder", () => {
  it("names output columns only, which is all a UNION accepts", () => {
    expect(isNewestFirst(undefined)).toBe(true);
    expect(isNewestFirst({ key: "cost", dir: "desc" })).toBe(false);
    expect(runIndexOrder({ key: "cost", dir: "asc" })).toHaveLength(3);
  });
});

describe("readRunIndexPage", () => {
  const ledgerA = ledgerRun({
    publicId: "arun_a",
    runId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  });
  const tachoB = tachoSession({ publicId: "tse_b" });
  const tachoC = tachoSession({ publicId: "tse_c" });

  function deps(entries: { source: "ledger" | "tacho"; publicId: string }[]) {
    const ledger = vi.fn((_scope: unknown, ids: readonly string[]) =>
      Promise.resolve(
        [ledgerA].filter((row) => ids.includes(row.run.publicId)),
      ),
    );
    const tacho = vi.fn((_scope: unknown, ids: readonly string[]) =>
      // Answered in another order than asked: the page keeps the index's.
      Promise.resolve(
        [tachoC, tachoB].filter((row) => ids.includes(row.session.publicId)),
      ),
    );
    const store: RunIndexDeps = {
      index: {
        page: vi.fn(() => Promise.resolve(entries)),
        count: vi.fn(() => Promise.resolve(0)),
      },
      rows: { ledger, tacho },
    };
    return { store, ledger, tacho };
  }

  it("keeps the index's order across both stores and says more follow", async () => {
    const { store } = deps([
      { source: "tacho", publicId: "tse_b" },
      { source: "ledger", publicId: "arun_a" },
      { source: "tacho", publicId: "tse_c" },
    ]);
    const page = await readRunIndexPage(store, SCOPE, request({ limit: 2 }));
    expect(page.items.map((item) => item.id)).toEqual(["tse_b", "arun_a"]);
    expect(page.more).toBe(true);
    expect(page.items[1]?.startedAt).toBe("2026-09-11T10:00:01.000Z");
  });

  it("drops a run removed between the two reads and reads no store it does not need", async () => {
    const { store, ledger } = deps([
      { source: "tacho", publicId: "tse_gone" },
      { source: "tacho", publicId: "tse_c" },
    ]);
    const page = await readRunIndexPage(store, SCOPE, request({ limit: 5 }));
    expect(page.items.map((item) => item.id)).toEqual(["tse_c"]);
    expect(page.more).toBe(false);
    expect(ledger).not.toHaveBeenCalled();
  });
});

describe("the total", () => {
  it("is exact up to the bound and null past it", () => {
    expect(totalOf(0)).toEqual({ total: 0, totalBound: RUN_LIST_TOTAL_BOUND });
    expect(totalOf(RUN_LIST_TOTAL_BOUND)).toEqual({
      total: RUN_LIST_TOTAL_BOUND,
      totalBound: RUN_LIST_TOTAL_BOUND,
    });
    expect(totalOf(RUN_LIST_TOTAL_BOUND + 1)).toEqual({
      total: null,
      totalBound: RUN_LIST_TOTAL_BOUND,
    });
  });

  const index = (count: () => Promise<number>) => ({
    page: vi.fn(() => Promise.resolve([])),
    count: vi.fn(count),
  });

  it("counts a page with no pull-request filter", async () => {
    const store = index(() => Promise.resolve(279));
    expect(await countRuns(store, SCOPE, request())).toEqual({
      total: 279,
      totalBound: RUN_LIST_TOTAL_BOUND,
    });
  });

  it("is absent under a pull-request filter, which only the frames answer", async () => {
    const store = index(() => Promise.resolve(3));
    expect(
      await countRuns(store, SCOPE, request({ sessionsOnly: true })),
    ).toEqual({});
    expect(store.count).not.toHaveBeenCalled();
  });

  it("is absent when the count fails, and the page stays up", async () => {
    const store = index(() => Promise.reject(new Error("statement timeout")));
    expect(await countRuns(store, SCOPE, request())).toEqual({});
  });
});
