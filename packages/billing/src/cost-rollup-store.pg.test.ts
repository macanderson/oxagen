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
import type { RunTotalsRecord } from "./cost-rollup";
import {
  type IncompleteCostRun,
  listRunsWithIncompleteCost,
  listRunsWithUnassignedCostCenter,
  upsertRunTotals,
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

  // `models` is what the rollup writes: a group it priced carries its cost
  // as a decimal string, a group no frame of which was priced carries null,
  // and `hasUnpriced` marks a group holding at least one unpriced call even
  // when a sibling call to the same model DID price (see `mixed` below,
  // which models #3271 residue G2: one model, one priced call, one not).
  const models = (...costs: (string | null)[]) =>
    costs.map((costMicros, i) => ({
      model: `m${i}`,
      calls: 1,
      costMicros,
      hasUnpriced: costMicros === null,
    }));

  // One model, two calls: one priced (`costMicros` non-null), one not. The
  // group's own `costMicros` alone reads as fully priced; only `hasUnpriced`
  // says otherwise.
  const mixedModel = (costMicros: string) => [
    { model: "mixed", calls: 2, costMicros, hasUnpriced: true },
  ];

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
        // The run's own basis and its one model group's costMicros both read
        // as fully priced; only that group's hasUnpriced says one of its two
        // calls went unpriced (#3271 residue G2).
        row(
          "mixed",
          "2001-01-01T00:00:05.000Z",
          { micros: 10n, basis: "gateway_observed" },
          mixedModel("10"),
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

  it("lists a run whose one model group mixes a priced and an unpriced call (#3271 residue G2)", async () => {
    // The mutation this guards against is reading a model group's costMicros
    // alone: `mixed` carries one model group with costMicros: "10", which
    // reads as fully priced on that field even though one of its two calls
    // never priced. Only hasUnpriced on the group says so, and only that
    // field keeps this run in the scan a backfilled rate can still repair.
    const after = {
      runId: id("partial"),
      startedAt: "2001-01-01T00:00:04.000Z",
    };
    const page = await listRunsWithIncompleteCost({ limit: 5, after });
    expect(page.map((r) => r.runId)).toContain(id("mixed"));
  });

  it("returns the head of the list without a cursor", async () => {
    const page = await listRunsWithIncompleteCost({ limit: 1 });
    expect(page).toEqual([
      { runId: id("a"), startedAt: "2001-01-01T00:00:00.000Z" },
    ]);
  });
});

// A stale rebuild racing a fresher one (#3271 residue G1): cost.run-rollup
// and cost.price-book-reprice can both rebuild the same sealed run
// concurrently, each reading the price book fresh, and the naive upsert lets
// whichever writes LAST win — even when it read a staler book. upsertRunTotals
// refuses a write that would take a fully-priced row back to incomplete for
// the SAME frame count, which is the one case a stale-book race can produce.
describe.skipIf(!enabled)(
  "upsertRunTotals write guard (#3271 residue G1)",
  () => {
    const scope = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const tag = crypto.randomUUID().slice(0, 8);
    const runId = (name: string) => `tse_pgtest_g1_${tag}_${name}`;

    const base = (runId: string): RunTotalsRecord => ({
      runId,
      runSource: "tacho",
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      operatorPrincipalId: null,
      operatorKey: null,
      agentPrincipalId: null,
      agentKey: null,
      taskRef: null,
      costCenter: null,
      startedAt: new Date("2001-06-01T00:00:00.000Z"),
      sealedAt: new Date("2001-06-01T00:05:00.000Z"),
      turns: null,
      retries: null,
      enforcementTier: null,
      replayGrade: null,
      steps: 2,
      modelCalls: 2,
      toolCalls: 0,
      tokens: {
        input_uncached: 1000,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        output: 100,
        reasoning: 0,
      },
      currency: "USD",
      priceEntryIds: [],
      cacheHitRate: null,
      verdict: null,
      accepted: null,
      productiveRatio: null,
      // Overwritten per test.
      costMicros: null,
      costBasis: null,
      breakdown: { models: [], tools: [] },
    });

    const priced: RunTotalsRecord = {
      ...base(runId("race")),
      costMicros: 4500n,
      costBasis: "gateway_observed",
      breakdown: {
        models: [
          {
            model: "claude-sonnet-5",
            provider: "anthropic",
            calls: 2,
            tokens: base(runId("race")).tokens,
            costMicros: 4500n,
            costByClass: {
              input_uncached: 3000n,
              cache_read: 0n,
              cache_write_5m: 0n,
              cache_write_1h: 0n,
              output: 1500n,
              reasoning: 0n,
            },
            basis: "gateway_observed",
            hasUnpriced: false,
          },
        ],
        tools: [],
      },
    };

    afterAll(async () => {
      await withSystemDb((tx) =>
        tx.delete(totals).where(eq(totals.workspaceId, scope.workspaceId)),
      );
      await closeDatabase();
    });

    it("refuses a stale rebuild that would revert a fully-priced run to incomplete", async () => {
      const id = runId("race");
      await upsertRunTotals({ ...priced, runId: id }, new Date());
      // A stale rebuild of the SAME frame count (modelCalls: 2), reporting
      // nothing priced: the shape a rebuild produces when it read the price
      // book before a sync committed. This is what run-rollup would write if
      // it landed AFTER the repricer already fixed the row.
      const stale: RunTotalsRecord = {
        ...base(id),
        costMicros: null,
        costBasis: null,
        breakdown: {
          models: [
            {
              model: "claude-sonnet-5",
              provider: "anthropic",
              calls: 2,
              tokens: base(id).tokens,
              costMicros: null,
              costByClass: {
                input_uncached: 0n,
                cache_read: 0n,
                cache_write_5m: 0n,
                cache_write_1h: 0n,
                output: 0n,
                reasoning: 0n,
              },
              basis: null,
              hasUnpriced: true,
            },
          ],
          tools: [],
        },
      };
      // The stale write lands AFTER the priced one, as it would in the race.
      await upsertRunTotals(stale, new Date());

      const [row] = await withSystemDb((tx) =>
        tx.select().from(totals).where(eq(totals.runId, id)).limit(1),
      );
      expect(row?.costBasis).toBe("gateway_observed");
      expect(row?.costMicros).toBe(4500n);
    });

    it("still applies a write that makes an incomplete run MORE complete", async () => {
      const id = runId("recover");
      const stale: RunTotalsRecord = {
        ...base(id),
        costMicros: null,
        costBasis: null,
        breakdown: {
          models: [
            {
              model: "claude-sonnet-5",
              provider: "anthropic",
              calls: 2,
              tokens: base(id).tokens,
              costMicros: null,
              costByClass: {
                input_uncached: 0n,
                cache_read: 0n,
                cache_write_5m: 0n,
                cache_write_1h: 0n,
                output: 0n,
                reasoning: 0n,
              },
              basis: null,
              hasUnpriced: true,
            },
          ],
          tools: [],
        },
      };
      await upsertRunTotals(stale, new Date());
      // A later, correct rebuild once the book prices the model — this is what
      // the repricer or a normal re-roll is FOR, and must not be blocked.
      await upsertRunTotals({ ...priced, runId: id }, new Date());

      const [row] = await withSystemDb((tx) =>
        tx.select().from(totals).where(eq(totals.runId, id)).limit(1),
      );
      expect(row?.costBasis).toBe("gateway_observed");
      expect(row?.costMicros).toBe(4500n);
    });

    it("still applies a write with a different frame count, even if it looks like a regression", async () => {
      const id = runId("newframe");
      await upsertRunTotals({ ...priced, runId: id }, new Date());
      // A genuinely different frame set (modelCalls: 3, not 2) must never be
      // refused by the guard: it is not the same run's stale re-read, so the
      // frame-count check must let it through even though its cost is blank.
      const grown: RunTotalsRecord = {
        ...base(id),
        modelCalls: 3,
        costMicros: null,
        costBasis: null,
        breakdown: { models: [], tools: [] },
      };
      await upsertRunTotals(grown, new Date());

      const [row] = await withSystemDb((tx) =>
        tx.select().from(totals).where(eq(totals.runId, id)).limit(1),
      );
      expect(row?.costBasis).toBe(null);
      expect(row?.modelCalls).toBe(3);
    });
  },
);

// The backfill's lister (ADR-142): a run charged to no cost center is listed
// once its agent, or its workspace, names a live label, and not otherwise.
// The fixture is one organization with two workspaces, `core` charged to
// MKT-2002 and `lab` charged to nothing, and two agents in `core`: `alpha`
// charged to ENG-1001 through its principal, `beta` charged to nothing.
describe.skipIf(!enabled)(
  "listRunsWithUnassignedCostCenter against Postgres",
  () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const orgId = crypto.randomUUID();
    const runId = (name: string) => `tse_ccbf_${tag}_${name}`;
    const namespace = () => crypto.randomUUID().replace(/-/g, "").slice(0, 6);
    let core = "";
    let lab = "";
    let alphaPrincipal = "";
    let betaPrincipal = "";

    const row = (
      name: string,
      at: string,
      over: {
        workspaceId: string;
        agentPrincipalId: string | null;
        costCenter?: string | null;
      },
    ) => ({
      orgId,
      workspaceId: over.workspaceId,
      runId: runId(name),
      runSource: "tacho",
      agentPrincipalId: over.agentPrincipalId,
      costCenter: over.costCenter ?? null,
      startedAt: new Date(at),
      steps: 1,
      modelCalls: 1,
      toolCalls: 0,
      tokens: {},
      costMicros: 10n,
      costBasis: "gateway_observed",
      breakdown: { models: [], tools: [] },
      rolledUpAt: new Date("2026-09-15T00:00:00.000Z"),
    });

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.organizations).values({
          id: orgId,
          name: `Cost center backfill ${tag}`,
          slug: `ccbf-${tag}`,
          namespace: namespace(),
          planType: "free",
          status: "active",
        });
        const [ws1] = await tx
          .insert(schema.workspaces)
          .values({
            orgId,
            name: "core",
            slug: `core-${tag}`,
            namespace: namespace(),
            costCenter: "MKT-2002",
          })
          .returning({ id: schema.workspaces.id });
        const [ws2] = await tx
          .insert(schema.workspaces)
          .values({
            orgId,
            name: "lab",
            slug: `lab-${tag}`,
            namespace: namespace(),
          })
          .returning({ id: schema.workspaces.id });
        core = ws1!.id;
        lab = ws2!.id;
        const principals = await tx
          .insert(schema.principals)
          .values([
            { orgId, workspaceId: core, kind: "agent", displayName: "alpha" },
            { orgId, workspaceId: core, kind: "agent", displayName: "beta" },
          ])
          .returning({
            id: schema.principals.id,
            displayName: schema.principals.displayName,
          });
        alphaPrincipal = principals.find((p) => p.displayName === "alpha")!.id;
        betaPrincipal = principals.find((p) => p.displayName === "beta")!.id;
        await tx.insert(schema.agents).values([
          {
            orgId,
            workspaceId: core,
            slug: "alpha",
            name: "alpha",
            agentType: "custom",
            principalId: alphaPrincipal,
            costCenter: "ENG-1001",
          },
          {
            orgId,
            workspaceId: core,
            slug: "beta",
            name: "beta",
            agentType: "custom",
            principalId: betaPrincipal,
          },
        ]);
        await tx.insert(schema.costCenters).values([
          { orgId, label: "ENG-1001" },
          { orgId, label: "MKT-2002" },
          // A deleted label claims no rollup, so a run under it stays out.
          {
            orgId,
            label: "OLD-9",
            deletedAt: new Date("2026-09-01T00:00:00.000Z"),
          },
        ]);
        await tx.insert(totals).values([
          // alpha's label applies.
          row("alpha1", "2001-02-01T00:00:00.000Z", {
            workspaceId: core,
            agentPrincipalId: alphaPrincipal,
          }),
          // beta names none; core's label applies.
          row("beta1", "2001-02-01T00:00:01.000Z", {
            workspaceId: core,
            agentPrincipalId: betaPrincipal,
          }),
          // No agent row at all; core's label still applies.
          row("noagent", "2001-02-01T00:00:02.000Z", {
            workspaceId: core,
            agentPrincipalId: null,
          }),
          // lab names none and neither does its run: stays unassigned.
          row("lab1", "2001-02-01T00:00:03.000Z", {
            workspaceId: lab,
            agentPrincipalId: null,
          }),
          // Already charged: not the backfill's to move.
          row("charged", "2001-02-01T00:00:04.000Z", {
            workspaceId: core,
            agentPrincipalId: alphaPrincipal,
            costCenter: "ENG-1001",
          }),
        ]);
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.delete(totals).where(eq(totals.orgId, orgId));
        await tx.delete(schema.agents).where(eq(schema.agents.orgId, orgId));
        await tx
          .delete(schema.principals)
          .where(eq(schema.principals.orgId, orgId));
        await tx
          .delete(schema.costCenters)
          .where(eq(schema.costCenters.orgId, orgId));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.orgId, orgId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
      });
      await closeDatabase();
    });

    it("lists the unassigned runs a live label now claims, oldest first, and no other", async () => {
      const page = await listRunsWithUnassignedCostCenter({
        limit: 10,
        orgId,
      });
      expect(page.map((r) => r.runId)).toEqual([
        runId("alpha1"),
        runId("beta1"),
        runId("noagent"),
      ]);
      expect(page[0]).toMatchObject({ orgId, workspaceId: core });
    });

    it("pages through the list with the cursor and ends", async () => {
      const first = await listRunsWithUnassignedCostCenter({
        limit: 2,
        orgId,
      });
      expect(first).toHaveLength(2);
      const second = await listRunsWithUnassignedCostCenter({
        limit: 2,
        orgId,
        after: first[1],
      });
      expect(second.map((r) => r.runId)).toEqual([runId("noagent")]);
      const third = await listRunsWithUnassignedCostCenter({
        limit: 2,
        orgId,
        after: second[0],
      });
      expect(third).toEqual([]);
    });

    it("leaves a run out once its label is cleared or deleted (negative)", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ costCenter: "OLD-9" })
          .where(eq(schema.workspaces.id, core)),
      );
      try {
        const page = await listRunsWithUnassignedCostCenter({
          limit: 10,
          orgId,
        });
        // alpha still resolves through its own label; the workspace's is dead.
        expect(page.map((r) => r.runId)).toEqual([runId("alpha1")]);
      } finally {
        await withSystemDb((tx) =>
          tx
            .update(schema.workspaces)
            .set({ costCenter: "MKT-2002" })
            .where(eq(schema.workspaces.id, core)),
        );
      }
    });
  },
);
