// The agent baseline `get_run_cost` answers (#3984, ADR-199): which runs the
// window reads, rendered from the query itself, and how the fold turns into
// the contract's figures. The same read against Postgres is in
// run-cost-baseline.pg.test.ts.
import { schema } from "@oxagen/database";
import {
  RUN_COST_BASELINE_MIN_RUNS,
  runCostBaselineSchema,
} from "@oxagen/oxagen/contracts/run.cost";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  aggregateOf,
  type BaselineAggregate,
  baselineOf,
  baselineQuery,
  microsHalfEven,
} from "./run-cost-baseline";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const RUN = {
  runId: "tse_0000000000000000000009",
  agentKey: "acme.core.cc",
  startedAt: new Date("2026-09-10T12:00:00.000Z"),
  currency: "USD",
};

/** A window of `runs` sealed runs, every one priced and graded. */
function window(over: Partial<BaselineAggregate> = {}): BaselineAggregate {
  return {
    runs: 12,
    priced: 12,
    medianMicros: 2_890_000,
    bases: ["gateway_observed"],
    graded: 12,
    advancedSteps: 62,
    gradedSteps: 100,
    ...over,
  };
}

describe("baselineQuery", () => {
  const db = drizzle.mock({ schema });
  const { sql, params } = baselineQuery(db, SCOPE, RUN).toSQL();

  it("reads the agent's runs in the run's own workspace", () => {
    expect(sql).toMatch(/"run_totals"\."org_id" = \$\d+/);
    expect(sql).toMatch(/"run_totals"\."workspace_id" = \$\d+/);
    expect(sql).toMatch(/"run_totals"\."agent_key" = \$\d+/);
    expect(params).toEqual(
      expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId, RUN.agentKey]),
    );
  });

  it("ignores a run that is still open", () => {
    expect(sql).toMatch(/"run_totals"\."sealed_at" is not null/);
  });

  it("reads the 30 days before the run started, and leaves the run itself out", () => {
    expect(sql).toMatch(/"run_totals"\."started_at" >= \$\d+/);
    expect(sql).toMatch(/"run_totals"\."started_at" < \$\d+/);
    expect(sql).toMatch(/"run_totals"\."run_id" <> \$\d+/);
    expect(params).toEqual(
      expect.arrayContaining([
        "2026-08-11T12:00:00.000Z",
        "2026-09-10T12:00:00.000Z",
        RUN.runId,
      ]),
    );
  });

  it("weighs the ratio by steps: the sums over graded runs, not a mean of ratios", () => {
    expect(sql).toContain(
      'sum("cost"."run_totals"."advanced_steps") filter (where "cost"."run_totals"."advanced_steps" is not null)',
    );
    expect(sql).toContain(
      'sum("cost"."run_totals"."steps") filter (where "cost"."run_totals"."advanced_steps" is not null)',
    );
    expect(sql).not.toMatch(/avg\(/);
  });

  it("takes the median of the runs priced in the run's currency", () => {
    expect(sql).toContain(
      'percentile_cont(0.5) within group (order by "cost"."run_totals"."cost_micros")',
    );
    expect(sql).toMatch(/"run_totals"\."currency" = \$\d+/);
  });
});

describe("baselineOf", () => {
  it("answers the median cost with its folded basis and the step-weighted ratio", () => {
    const baseline = baselineOf(
      RUN,
      window({ bases: ["gateway_observed", "client_attested"] }),
    );
    expect(baseline).toEqual({
      windowDays: 30,
      before: "2026-09-10T12:00:00.000Z",
      runs: 12,
      medianCost: { micros: "2890000", currency: "USD", basis: "mixed" },
      productiveRatio: 0.62,
    });
    expect(runCostBaselineSchema.safeParse(baseline).success).toBe(true);
  });

  it("answers null for a history thinner than the minimum", () => {
    expect(
      baselineOf(RUN, window({ runs: RUN_COST_BASELINE_MIN_RUNS - 1 })),
    ).toBeNull();
    expect(baselineOf(RUN, aggregateOf(undefined))).toBeNull();
  });

  it("answers a median only over enough priced runs, and a ratio only over enough graded ones", () => {
    const thin = baselineOf(
      RUN,
      window({
        priced: RUN_COST_BASELINE_MIN_RUNS - 1,
        graded: RUN_COST_BASELINE_MIN_RUNS - 1,
      }),
    );
    expect(thin?.runs).toBe(12);
    expect(thin?.medianCost).toBeNull();
    expect(thin?.productiveRatio).toBeNull();
  });

  it("lets an estimated run make the median an estimate", () => {
    const baseline = baselineOf(
      RUN,
      window({ bases: ["gateway_observed", "estimated"] }),
    );
    expect(baseline?.medianCost?.basis).toBe("estimated");
  });

  it("weighs a long run by its steps", () => {
    // One run of 90 steps with 81 advanced and four of 5 steps with none: a
    // mean of ratios says 18%, the steps say 81 of 110.
    const baseline = baselineOf(
      RUN,
      window({ graded: 5, advancedSteps: 81, gradedSteps: 110 }),
    );
    expect(baseline?.productiveRatio).toBeCloseTo(81 / 110, 12);
  });
});

describe("the fold's numbers", () => {
  it("rounds a median ending in a half to the even micro", () => {
    expect(microsHalfEven(2_890_000.5)).toBe(2_890_000n);
    expect(microsHalfEven(2_890_001.5)).toBe(2_890_002n);
    expect(microsHalfEven(2_890_000.25)).toBe(2_890_000n);
    expect(microsHalfEven(2_890_000.75)).toBe(2_890_001n);
  });

  it("reads Postgres's text numerics and answers zeros for an empty window", () => {
    expect(
      aggregateOf({
        runs: 6,
        priced: 5,
        medianMicros: "1250.5",
        bases: ["client_attested"],
        graded: 5,
        advancedSteps: "40",
        gradedSteps: "50",
      }),
    ).toEqual({
      runs: 6,
      priced: 5,
      medianMicros: 1250.5,
      bases: ["client_attested"],
      graded: 5,
      advancedSteps: 40,
      gradedSteps: 50,
    });
    expect(aggregateOf(undefined)).toEqual({
      runs: 0,
      priced: 0,
      medianMicros: null,
      bases: [],
      graded: 0,
      advancedSteps: 0,
      gradedSteps: 0,
    });
  });
});
