import { schema } from "@oxagen/database";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.shared";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  readRunTotals,
  readUnmeteredRuns,
  runFigure,
  sumFigures,
} from "./spend.shared";
import { daily, OPERATOR, run, SCOPE } from "./spend.test-support";

/**
 * Hands the read a mock database and keeps the query it built without running
 * it. The read gets `rows` back, as if Postgres had answered them.
 */
function captureQuery(rows: unknown[] = []) {
  const db = drizzle.mock({ schema });
  const captured: { sql: string; params: unknown[] }[] = [];
  mocks.withTenantDb.mockImplementation((fn: (tx: typeof db) => unknown) => {
    const query = fn(db) as { toSQL(): { sql: string; params: unknown[] } };
    captured.push(query.toSQL());
    return Promise.resolve(rows);
  });
  return captured;
}

/** A `cost.run_totals` row as Postgres answers it, with no frame priced. */
function storedRow(runId: string) {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000000d1",
    orgId: SCOPE.orgId,
    workspaceId: SCOPE.workspaceId,
    runId,
    runSource: runId.startsWith("tse_") ? "tacho" : "ledger",
    operatorPrincipalId: null,
    operatorKey: null,
    agentPrincipalId: null,
    agentKey: null,
    taskRef: null,
    costCenter: null,
    startedAt: new Date("2026-09-01T10:00:00.000Z"),
    sealedAt: null,
    turns: null,
    steps: 1,
    modelCalls: 1,
    toolCalls: 0,
    tokens: {},
    costMicros: null,
    currency: "USD",
    costBasis: null,
    priceEntryIds: [],
    cacheHitRate: null,
    toolDefinitionTokens: null,
    contextFrameTokens: null,
    steeringTokens: null,
    retries: null,
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
    enforcementTier: null,
    replayGrade: null,
    governedActions: null,
    billedAt: null,
    breakdown: { models: [], tools: [], steps: null },
    rolledUpAt: new Date("2026-09-01T11:00:00.000Z"),
  };
}

describe("readRunTotals", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
  });

  it("fences on the scope and the day window as [start, next)", async () => {
    const captured = captureQuery();
    await readRunTotals(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-02",
      filter: { kind: "all" },
    });
    const [q] = captured;
    expect(q!.sql).toMatch(/"run_totals"\."org_id" = \$\d+/);
    expect(q!.sql).toMatch(/"run_totals"\."workspace_id" = \$\d+/);
    expect(q!.sql).toMatch(/"run_totals"\."started_at" >= \$\d+/);
    expect(q!.sql).toMatch(/"run_totals"\."started_at" < \$\d+/);
    // The in-app surfaces come first, bound by the `inApp` column in the
    // select list. The timestamp column's driver encoding is the ISO string.
    expect(q!.params).toEqual([
      ...IN_APP_AGENT_SURFACES,
      SCOPE.orgId,
      SCOPE.workspaceId,
      "2026-09-01T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
  });

  // ADR-235, 2026-10-02 amendment. Every total counts the in-app assistant's
  // runs, and no list names one. The read keeps every row and marks the
  // assistant's. `spend.shared.pg.test.ts` proves the rows against Postgres.
  it("marks each row whose run is the in-app assistant's and filters out none", async () => {
    const captured = captureQuery();
    await readRunTotals(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-01",
      filter: { kind: "all" },
    });
    // The subquery sits in the select list, so the outer FROM and WHERE are
    // the last ones in the statement.
    const { sql } = captured[0]!;
    const select = sql.slice(0, sql.lastIndexOf(" from "));
    const where = sql.slice(sql.lastIndexOf(" where "));
    expect(select).toContain(
      'exists (select 1 from "agent"."agent_runs" as "in_app_run" where "in_app_run"."public_id" = ',
    );
    // The row's id is cast to citext, so the unique index on the run's
    // public id serves the lookup.
    expect(select).toMatch(
      /"in_app_run"\."public_id" = (?:"cost"\.)?"run_totals"\."run_id"::citext/,
    );
    expect(select).toMatch(
      /"in_app_run"\."org_id" = (?:"cost"\.)?"run_totals"\."org_id"/,
    );
    expect(select).toMatch(
      /"in_app_run"\."workspace_id" = (?:"cost"\.)?"run_totals"\."workspace_id"/,
    );
    expect(select).toMatch(/"in_app_run"\."surface" in \(\$\d+, \$\d+\)/);
    // No row is filtered on its surface.
    expect(where).not.toContain("agent_runs");
  });

  it("answers inApp from the column, true only when Postgres said true", async () => {
    captureQuery([
      { ...storedRow("arun_assistant"), inApp: true },
      { ...storedRow("arun_external"), inApp: false },
      { ...storedRow("tse_session"), inApp: null },
    ]);
    const rows = await readRunTotals(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-01",
      filter: { kind: "all" },
    });
    expect(rows.map((r) => [r.runId, r.inApp])).toEqual([
      ["arun_assistant", true],
      ["arun_external", false],
      ["tse_session", false],
    ]);
  });

  it("filters an operator on the principal's public id, never the uuid column", async () => {
    const captured = captureQuery();
    await readRunTotals(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-01",
      filter: { kind: "operator", key: OPERATOR },
    });
    const [q] = captured;
    // The last WHERE is the outer one. The `inApp` subquery has its own.
    const where = q!.sql.slice(q!.sql.lastIndexOf(" where "));
    expect(where).toMatch(/"run_totals"\."operator_key" = \$\d+/);
    expect(where).not.toContain("operator_principal_id");
    expect(q!.params).toContain(OPERATOR);
  });

  it("filters an agent on agent_key and a tool on the breakdown's tool names", async () => {
    const captured = captureQuery();
    await readRunTotals(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-01",
      filter: { kind: "agent", key: "acme.core.cc" },
    });
    await readRunTotals(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-01",
      filter: { kind: "tool", key: "Bash" },
    });
    expect(captured[0]!.sql).toMatch(/"run_totals"\."agent_key" = \$\d+/);
    expect(captured[0]!.params).toContain("acme.core.cc");
    expect(captured[1]!.sql).toMatch(/"breakdown"->'tools' @> \$\d+::jsonb/);
    expect(captured[1]!.params).toContain(JSON.stringify([{ name: "Bash" }]));
  });
});

describe("sumFigures", () => {
  it("weights each day's productive ratio by its graded steps", () => {
    // 9 of 10 steps advanced one day and 0 of 2 the next: 9 of 12 overall.
    // A run-weighted mean would read 0.45.
    const out = sumFigures([
      daily({ productiveRatio: 0.9, gradedSteps: 10 }),
      daily({ productiveRatio: 0, gradedSteps: 2 }),
    ]);
    expect(out.productiveRatio).toBeCloseTo(9 / 12);
  });

  it("weighs a day rolled up before the weight was stored by its run count", () => {
    const out = sumFigures([
      daily({ productiveRatio: 1, gradedSteps: null, runs: 3 }),
      daily({ productiveRatio: 0, gradedSteps: 1 }),
    ]);
    expect(out.productiveRatio).toBeCloseTo(3 / 4);
  });

  it("weights a run by its steps once the rollup has graded it", () => {
    const graded = run({
      steps: 4,
      advancedSteps: 1,
      unproductiveSteps: 3,
      productiveRatio: 0.25,
    });
    expect(runFigure(graded).gradedSteps).toBe(4);
    expect(runFigure(run()).gradedSteps).toBeNull();
  });
});

// #3304. A wrapped run whose model calls bypass the gateway and the local
// proxy records no usage, so every spend total leaves its cost out. The read
// counts those runs by harness so the page can say so.
describe("readUnmeteredRuns", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
  });

  it("counts the scope's wrapped runs with no model call in the window, by harness", async () => {
    const captured = captureQuery();
    await readUnmeteredRuns(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-02",
      filter: { kind: "all" },
    });
    const [q] = captured;
    const where = q!.sql.slice(q!.sql.indexOf(" where "));
    expect(where).toMatch(/"run_totals"\."org_id" = \$\d+/);
    expect(where).toMatch(/"run_totals"\."workspace_id" = \$\d+/);
    expect(where).toMatch(/"run_totals"\."run_source" = \$\d+/);
    expect(where).toMatch(/"run_totals"\."model_calls" = \$\d+/);
    // A run that just opened holds no model call yet, so an open run counts
    // only once it has made a tool call.
    expect(where).toMatch(/"run_totals"\."sealed_at" is not null/);
    expect(where).toMatch(/"run_totals"\."tool_calls" > \$\d+/);
    expect(where).toMatch(/"run_totals"\."started_at" >= \$\d+/);
    expect(where).toMatch(/"run_totals"\."started_at" < \$\d+/);
    // The harness is the session's, joined on the run's public id in the
    // run's own organization and workspace.
    expect(q!.sql).toMatch(/left join (?:"tacho"\.)?"sessions"/);
    expect(q!.sql).toMatch(
      /"sessions"\."public_id" = (?:"cost"\.)?"run_totals"\."run_id"/,
    );
    // A blank harness joins `unknown` rather than naming a harness with no
    // name, which the Spend page's view schema refuses.
    expect(q!.sql).toMatch(
      /group by coalesce\(nullif\((?:"tacho"\.)?"sessions"\."harness", ''\), 'unknown'\)/,
    );
    expect(q!.params).toEqual(
      expect.arrayContaining([
        SCOPE.orgId,
        SCOPE.workspaceId,
        "tacho",
        0,
        "2026-09-01T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
      ]),
    );
  });

  it("applies a drill's own filter so the count matches the runs its total covers", async () => {
    const captured = captureQuery();
    await readUnmeteredRuns(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-01",
      filter: { kind: "operator", key: OPERATOR },
    });
    const [q] = captured;
    expect(q!.sql).toMatch(/"run_totals"\."operator_key" = \$\d+/);
    expect(q!.params).toContain(OPERATOR);
  });

  it("answers the total and the harnesses, most runs first", async () => {
    captureQuery([
      { harness: "cursor", runs: 1 },
      { harness: "codex", runs: 3 },
      { harness: "stella", runs: 1 },
    ]);
    const out = await readUnmeteredRuns(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-30",
      filter: { kind: "all" },
    });
    expect(out).toEqual({
      total: 5,
      byHarness: [
        { harness: "codex", runs: 3 },
        { harness: "cursor", runs: 1 },
        { harness: "stella", runs: 1 },
      ],
    });
  });

  it("answers zero with no harness when every run reported usage", async () => {
    captureQuery([]);
    const out = await readUnmeteredRuns(SCOPE, {
      from: "2026-09-01",
      to: "2026-09-30",
      filter: { kind: "all" },
    });
    expect(out).toEqual({ total: 0, byHarness: [] });
  });
});
