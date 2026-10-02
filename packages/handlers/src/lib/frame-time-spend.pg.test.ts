// The frame-time spend reads against a real Postgres (#4574). The unit test
// drives the arithmetic through fakes. This runs the SQL: the contained sum,
// the crossing list with its last-frame bound, and both run-ref lookups, in a
// tenant scope that holds no row. Postgres parses and plans each statement, so
// a bad cast or a bound the planner refuses fails here rather than on a page
// view, and each read answers nothing.
//
// Runs wherever DATABASE_URL points at a migrated database (CI's `test` job);
// a local run without one is skipped, not red. It writes no rows.
import { closeDatabase } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { afterAll, describe, expect, it } from "vitest";
import { frameTimeSpendDeps } from "./frame-time-spend";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("frame-time spend against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const window = {
    start: new Date("2026-09-01T00:00:00.000Z"),
    end: new Date("2026-10-01T00:00:00.000Z"),
  };

  afterAll(async () => {
    await closeDatabase();
  });

  it.each([
    ["every run", null],
    ["named operators", ["prn_0000000000000000000ana"]],
  ] as const)(
    "lists no run for %s in an empty workspace",
    async (_label, keys) => {
      expect(
        await runInTenantScope(scope, () =>
          frameTimeSpendDeps.readRuns(scope, window, keys),
        ),
      ).toEqual({ contained: [], crossing: [] });
    },
  );

  it.each(["arun_0000000000000000000000", "tse_0000000000000000000000"])(
    "prices nothing for a run %s the workspace does not hold",
    async (runId) => {
      expect(
        await runInTenantScope(scope, () =>
          frameTimeSpendDeps.priceRunFrames(scope, runId, window),
        ),
      ).toBeNull();
    },
  );
});
