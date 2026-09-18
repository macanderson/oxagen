// listRunsWithIncompleteCost against a real Postgres: the cursor pages through
// every incomplete run exactly once, and a run that stays incomplete does not
// come back. Runs wherever DATABASE_URL points at a migrated database (CI's
// `test` job); a local run without one is skipped, not red. Every row it
// writes is removed in afterAll.
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

  const row = (
    name: string,
    startedAt: string,
    cost: { micros: bigint; basis: string } | null,
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
    breakdown: { models: [], tools: [] },
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
        row("priced", "2001-01-01T00:00:02.000Z", {
          micros: 10n,
          basis: "client_attested",
        }),
        row("d", "2001-01-01T00:00:03.000Z", null),
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
    for (let i = 0; i < 4; i += 1) {
      const page = await listRunsWithIncompleteCost({ limit: 2, after });
      // Nothing was rebuilt between pages, so every row is still incomplete:
      // only the cursor moves the read forward.
      seen.push(...page.map((r) => r.runId));
      after = page.at(-1);
      if (seen.includes(id("d"))) break;
    }
    expect(seen.slice(0, 4)).toEqual([id("a"), id("b"), id("c"), id("d")]);
    expect(seen).not.toContain(id("priced"));
  });

  it("returns the head of the list without a cursor", async () => {
    const page = await listRunsWithIncompleteCost({ limit: 1 });
    expect(page).toEqual([
      { runId: id("a"), startedAt: "2001-01-01T00:00:00.000Z" },
    ]);
  });
});
