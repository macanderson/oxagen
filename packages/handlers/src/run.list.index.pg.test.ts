// The run index's SQL against a real Postgres (#3837). run.list.index.test.ts
// reads the SQL drizzle renders. This runs it: every order in both
// directions, each filter, the search with its escaped wildcards, the
// sessions-only read, the witness filter, a cursor and an offset, against a
// workspace no row belongs to. Postgres parses and plans each statement, so a
// UNION ORDER BY on an expression, an ambiguous output name, a bad lateral
// join or an untyped parameter fails here rather than in production, and each
// read answers nothing.
//
// Runs wherever DATABASE_URL points at a migrated database (CI's `test` job);
// a local run without one is skipped, not red. It writes no rows.
import {
  RUN_SORT_KEYS,
  RUN_REPLAY_FILTERS,
} from "@oxagen/oxagen/contracts/run.list";
import { closeDatabase } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { afterAll, describe, expect, it } from "vitest";
import {
  NEWEST_FIRST,
  postgresRunIndex,
  type RunIndexRequest,
} from "./run.list.index";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("the run index against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const request = (over: Partial<RunIndexRequest> = {}): RunIndexRequest => ({
    order: NEWEST_FIRST,
    cursor: null,
    offset: 0,
    limit: 25,
    withoutWitnessRuns: false,
    sessionsOnly: false,
    ...over,
  });
  const read = (over: Partial<RunIndexRequest> = {}) =>
    runInTenantScope(scope, async () => ({
      page: await postgresRunIndex.page(scope, request(over)),
      count: await postgresRunIndex.count(scope, request(over)),
    }));

  afterAll(async () => {
    await closeDatabase();
  });

  it.each(
    RUN_SORT_KEYS.flatMap((key) =>
      (["asc", "desc"] as const).map((dir) => [key, dir] as const),
    ),
  )("orders by %s %s", async (key, dir) => {
    expect(await read({ order: { key, dir } })).toEqual({ page: [], count: 0 });
  });

  it.each([false, true])(
    "orders a sessions-only read (a pull-request filter): %s",
    async (sessionsOnly) => {
      for (const key of RUN_SORT_KEYS)
        expect(
          await read({ sessionsOnly, order: { key, dir: "asc" } }),
        ).toEqual({ page: [], count: 0 });
    },
  );

  it("filters on every status, tier and grade", async () => {
    expect(
      await read({
        status: ["live", "sealed", "halted"],
        tier: ["contained", "gateway", "harness", "observe"],
        replayGrade: [...RUN_REPLAY_FILTERS],
      }),
    ).toEqual({ page: [], count: 0 });
    expect(await read({ replayGrade: ["not_recorded"] })).toEqual({
      page: [],
      count: 0,
    });
  });

  it("searches with the wildcards and the escape character in the text", async () => {
    expect(await read({ query: "50%_off\\now" })).toEqual({
      page: [],
      count: 0,
    });
  });

  it("reads after a cursor, from an offset, and without witness runs", async () => {
    expect(
      await read({
        cursor: { at: "2026-09-11T10:00:00.000Z", id: "tse_b" },
        withoutWitnessRuns: true,
      }),
    ).toEqual({ page: [], count: 0 });
    expect(
      await read({ offset: 50, order: { key: "cost", dir: "desc" } }),
    ).toEqual({ page: [], count: 0 });
  });
});
