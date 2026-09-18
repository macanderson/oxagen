// listRunsWithIncompleteCost against a real Postgres: the cursor pages through
// every incomplete run exactly once, a run that stays incomplete does not come
// back, and a run whose basis names its priced frames while its breakdown
// still holds an unpriced model group is listed too. Runs wherever
// DATABASE_URL points at a migrated database (CI's `test` job); a local run
// without one is skipped, not red. Every row it writes is removed in afterAll.
//
// The rows start in 2001 so they sort ahead of whatever else the database
// holds: the lister reads every organization, oldest first.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type IncompleteCostRun,
  listRunsWithIncompleteCost,
} from "./cost-rollup-store";

const enabled = Boolean(process.env.DATABASE_URL);
const totals = schema.runTotals;

describe.skipIf(!enabled)("listRunsWithIncompleteCost against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const tag = crypto.randomUUID().slice(0, 8);
  const id = (name: string) => `tse_pgtest_${tag}_${name}`;

  // `models` is what the rollup writes: a group it priced carries its cost as
  // a decimal string, a group no frame of which was priced carries null.
  const models = (...costs: (string | null)[]) =>
    costs.map((costMicros, i) => ({ model: `m${i}`, calls: 1, costMicros }));

  const row = (
    name: string,
    startedAt: string,
    cost: { micros: bigint; basis: string } | null,
    breakdownModels: ReturnType<typeof models> = [],
  ) => ({
    ...scope,
    runId: id(name),
    runSource: "tacho",
    startedAt: new Date(startedAt),
    steps: 1,
    modelCalls: 1,
    toolCalls: 0,
    tokens: {},
    costMicros: cost?.micros ?? null,
    costBasis: cost?.basis ?? null,
    breakdown: { models: breakdownModels, tools: [] },
    rolledUpAt: new Date("2026-09-15T00:00:00.000Z"),
  });

  beforeAll(async () => {
    await withSystemDb((tx) =>
      tx.insert(totals).values([
        row("a", "2001-01-01T00:00:00.000Z", null),
        // Two rows in one millisecond: the run id breaks the tie.
        row("c", "2001-01-01T00:00:01.000Z", null),
        row("b", "2001-01-01T00:00:01.000Z", {
          micros: 10n,
          basis: "estimated",
        }),
        row(
          "priced",
          "2001-01-01T00:00:02.000Z",
          { micros: 10n, basis: "client_attested" },
          models("10"),
        ),
        row("d", "2001-01-01T00:00:03.000Z", null),
        // One priced frame and one the book prices nothing of: the basis
        // names the frame that was priced, so only the breakdown says the
        // total is short a call.
        row(
          "partial",
          "2001-01-01T00:00:04.000Z",
          { micros: 10n, basis: "gateway_observed" },
          models("10", null),
        ),
      ]),
    );
    // Microseconds the ISO cursor cannot carry.
    await withSystemDb((tx) =>
      tx.execute(
        sql`UPDATE cost.run_totals SET started_at = started_at + interval '250 microseconds' WHERE run_id = ${id("c")}`,
      ),
    );
  });

  afterAll(async () => {
    await withSystemDb((tx) =>
      tx.delete(totals).where(eq(totals.workspaceId, scope.workspaceId)),
    );
    await closeDatabase();
  });

  it("pages through every incomplete run once, in order, and skips a priced one", async () => {
    const seen: string[] = [];
    let after: IncompleteCostRun | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await listRunsWithIncompleteCost({ limit: 2, after });
      // Nothing was rebuilt between pages, so every row is still incomplete:
      // only the cursor moves the read forward.
      seen.push(...page.map((r) => r.runId));
      after = page.at(-1);
      if (seen.includes(id("partial"))) break;
    }
    expect(seen.slice(0, 5)).toEqual([
      id("a"),
      id("b"),
      id("c"),
      id("d"),
      id("partial"),
    ]);
    expect(seen).not.toContain(id("priced"));
  });

  it("lists a run whose basis is complete but whose breakdown holds an unpriced model", async () => {
    // The mutation this guards against is reading cost_basis alone: `partial`
    // is `gateway_observed`, so a basis-only predicate would drop it, and its
    // unpriced call would never be rebuilt after a catalog recovered.
    const after = {
      runId: id("d"),
      startedAt: "2001-01-01T00:00:03.000Z",
    };
    const page = await listRunsWithIncompleteCost({ limit: 5, after });
    expect(page.map((r) => r.runId)).toContain(id("partial"));
  });

  it("returns the head of the list without a cursor", async () => {
    const page = await listRunsWithIncompleteCost({ limit: 1 });
    expect(page).toEqual([
      { runId: id("a"), startedAt: "2001-01-01T00:00:00.000Z" },
    ]);
  });
});
