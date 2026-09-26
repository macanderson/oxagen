// The agent baseline against a real Postgres (#3984, ADR-199): the window
// counts the agent's sealed runs in the 30 days before the run started, and
// leaves out the run itself, an open run, a run outside the window, and
// another agent's. Runs wherever DATABASE_URL points at a migrated database
// (CI's `test` job); a local run without one is skipped, not red. Every row
// it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRunCostBaseline } from "./run-cost-baseline";

const enabled = Boolean(process.env.DATABASE_URL);
const totals = schema.runTotals;

describe.skipIf(!enabled)("readRunCostBaseline against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const agentKey = `acme.core.base${tag}`;
  const startedAt = new Date("2026-09-10T12:00:00.000Z");
  const day = (n: number) => new Date(startedAt.getTime() - n * 86_400_000);

  const row = (
    name: string,
    over: {
      startedAt: Date;
      costMicros: bigint | null;
      advancedSteps: number | null;
      steps?: number;
      sealed?: boolean;
      agentKey?: string;
      costBasis?: string;
    },
  ) => {
    const steps = over.steps ?? 10;
    return {
      ...scope,
      runId: `tse_base_${tag}_${name}`,
      runSource: "tacho",
      agentKey: over.agentKey ?? agentKey,
      startedAt: over.startedAt,
      sealedAt:
        over.sealed === false
          ? null
          : new Date(over.startedAt.getTime() + 600_000),
      steps,
      modelCalls: steps,
      toolCalls: 0,
      tokens: {},
      costMicros: over.costMicros,
      costBasis:
        over.costMicros === null
          ? null
          : (over.costBasis ?? "gateway_observed"),
      advancedSteps: over.advancedSteps,
      unproductiveSteps:
        over.advancedSteps === null ? null : steps - over.advancedSteps,
      breakdown: { models: [], tools: [], steps: null },
      rolledUpAt: new Date("2026-09-15T00:00:00.000Z"),
    };
  };

  beforeAll(async () => {
    await withSystemDb((tx) =>
      tx.insert(totals).values([
        // The window: six sealed runs of this agent, 1 to 29 days back.
        row("a", { startedAt: day(1), costMicros: 1_000n, advancedSteps: 9 }),
        row("b", { startedAt: day(3), costMicros: 2_000n, advancedSteps: 5 }),
        row("c", { startedAt: day(7), costMicros: 3_000n, advancedSteps: 1 }),
        row("d", {
          startedAt: day(12),
          costMicros: 4_000n,
          advancedSteps: 10,
          costBasis: "client_attested",
        }),
        row("e", { startedAt: day(20), costMicros: 5_000n, advancedSteps: 8 }),
        // Priced but graded before grading existed: counted, not in the ratio.
        row("f", {
          startedAt: day(29),
          costMicros: 6_000n,
          advancedSteps: null,
          steps: 40,
        }),
        // Left out: open, outside the window, another agent's, after the start.
        row("open", {
          startedAt: day(2),
          costMicros: 900_000n,
          advancedSteps: 0,
          sealed: false,
        }),
        row("old", { startedAt: day(31), costMicros: 900_000n, advancedSteps: 0 }),
        row("other", {
          startedAt: day(2),
          costMicros: 900_000n,
          advancedSteps: 0,
          agentKey: `acme.core.other${tag}`,
        }),
        row("later", {
          startedAt: new Date(startedAt.getTime() + 60_000),
          costMicros: 900_000n,
          advancedSteps: 0,
        }),
        // The run itself.
        row("self", { startedAt, costMicros: 900_000n, advancedSteps: 0 }),
      ]),
    );
  });

  afterAll(async () => {
    await withSystemDb((tx) =>
      tx.delete(totals).where(eq(totals.workspaceId, scope.workspaceId)),
    );
    await closeDatabase();
  });

  const read = (over: { agentKey?: string | null } = {}) =>
    runInTenantScope(scope, () =>
      readRunCostBaseline(scope, {
        runId: `tse_base_${tag}_self`,
        agentKey: over.agentKey === undefined ? agentKey : over.agentKey,
        startedAt,
        currency: "USD",
      }),
    );

  it("folds the agent's sealed runs before this one, and no other", async () => {
    const baseline = await read();
    expect(baseline).toEqual({
      windowDays: 30,
      before: startedAt.toISOString(),
      runs: 6,
      // The median of 1,000 to 6,000: halfway between 3,000 and 4,000.
      medianCost: { micros: "3500", currency: "USD", basis: "mixed" },
      // 33 advanced of the five graded runs' 50 steps.
      productiveRatio: 33 / 50,
    });
  });

  it("answers null for a run that names no agent", async () => {
    expect(await read({ agentKey: null })).toBeNull();
  });

  it("answers null for an agent whose history is thinner than the minimum", async () => {
    expect(await read({ agentKey: `acme.core.other${tag}` })).toBeNull();
  });
});
