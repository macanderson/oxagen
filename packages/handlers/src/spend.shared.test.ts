import { schema } from "@oxagen/database";
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

import { readRunTotals, runFigure, sumFigures } from "./spend.shared";
import { daily, OPERATOR, run, SCOPE } from "./spend.test-support";

/** Hands the read a mock database and keeps the query it built without running it. */
function captureQuery() {
  const db = drizzle.mock({ schema });
  const captured: { sql: string; params: unknown[] }[] = [];
  mocks.withTenantDb.mockImplementation((fn: (tx: typeof db) => unknown) => {
    const query = fn(db) as { toSQL(): { sql: string; params: unknown[] } };
    captured.push(query.toSQL());
    return Promise.resolve([]);
  });
  return captured;
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
    // The timestamp column's driver encoding is the ISO string.
    expect(q!.params).toEqual([
      SCOPE.orgId,
      SCOPE.workspaceId,
      "2026-09-01T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
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
    const where = q!.sql.slice(q!.sql.indexOf(" where "));
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
