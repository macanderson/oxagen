// #3834: a list_runs row's token counts and cache rate come from its
// cost.run_totals row, and a run with no row reads null, never zero.
import { schema } from "@oxagen/database";
import { describe, expect, it, vi } from "vitest";

const { rows } = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...actual,
    withTenantDb: (fn: (tx: unknown) => unknown) =>
      fn({
        select: (selection: Record<string, unknown>) => ({
          from: () => ({
            where: () => {
              // The read must select both columns, or no row carries them.
              expect(selection.tokens).toBe(actual.schema.runTotals.tokens);
              expect(selection.cacheHitRate).toBe(
                actual.schema.runTotals.cacheHitRate,
              );
              return Promise.resolve(rows);
            },
          }),
        }),
      }),
  };
});

import { createRunListHandler, postgresReadRunRollups } from "../run.list";
import {
  ctx,
  ledgerRun,
  memoryStores,
  rollupCostRow,
  SCOPE,
  tachoSession,
} from "../run.test-support";
import { rollupTokenFields, tokenCountsOf } from "./run-list-tokens";

const COUNTS = {
  input_uncached: 1_200,
  cache_read: 3_600,
  cache_write_5m: 400,
  cache_write_1h: 0,
  output: 900,
  reasoning: 100,
};

describe("rollupTokenFields", () => {
  it("reads a priced run's counts and cache rate", () => {
    expect(rollupTokenFields({ tokens: COUNTS, cacheHitRate: 0.75 })).toEqual({
      tokens: COUNTS,
      cacheHitRate: 0.75,
    });
  });

  it("reads an unpriced row's counts: the column is never null", () => {
    // A row whose frames priced nothing has no cost and still has counts.
    expect(
      rollupTokenFields({ tokens: { ...COUNTS }, cacheHitRate: null }),
    ).toEqual({ tokens: COUNTS, cacheHitRate: null });
  });

  it("reads a run with no rollup row as null, never zeros (negative)", () => {
    expect(rollupTokenFields(undefined)).toEqual({
      tokens: null,
      cacheHitRate: null,
    });
  });

  it("reads a run with no cache reads as a null rate, not 0 (negative)", () => {
    expect(
      rollupTokenFields({
        tokens: { ...COUNTS, cache_read: 0 },
        cacheHitRate: null,
      }).cacheHitRate,
    ).toBeNull();
  });

  it("leaves both out when the read did not select them", () => {
    expect(rollupTokenFields({})).toEqual({});
  });

  it("fills a class the row left out with zero, as the rollup writes it", () => {
    expect(tokenCountsOf({ input_uncached: 5, output: 2 })).toEqual({
      input_uncached: 5,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      output: 2,
      reasoning: 0,
    });
  });

  it.each([
    ["a string", "12"],
    ["an array", [1, 2]],
    ["a negative count", { ...COUNTS, output: -1 }],
    ["a fraction", { ...COUNTS, output: 1.5 }],
    ["a count that is not a number", { ...COUNTS, output: "9" }],
  ])("reads %s as not recorded (negative)", (_label, stored) => {
    expect(tokenCountsOf(stored)).toBeNull();
  });

  it("leaves out a class the contract does not name", () => {
    expect(tokenCountsOf({ ...COUNTS, audio: 3 })).toEqual(COUNTS);
  });

  it.each([1.2, -0.1, Number.NaN])(
    "reads a cache rate of %s as not recorded (negative)",
    (rate) => {
      expect(
        rollupTokenFields({ tokens: COUNTS, cacheHitRate: rate }).cacheHitRate,
      ).toBeNull();
    },
  );
});

describe("postgresReadRunRollups", () => {
  it("selects the token classes and turns the numeric cache rate into a number", async () => {
    rows.length = 0;
    rows.push(
      {
        runId: "tse_a",
        costMicros: 1_000n,
        currency: "USD",
        costBasis: "gateway_observed",
        verdict: null,
        sealedAt: null,
        tokens: COUNTS,
        cacheHitRate: "0.75000000",
      },
      {
        runId: "tse_b",
        costMicros: null,
        currency: "USD",
        costBasis: null,
        verdict: null,
        sealedAt: null,
        tokens: COUNTS,
        cacheHitRate: null,
      },
    );
    const out = await postgresReadRunRollups(SCOPE, ["tse_a", "tse_b"]);
    expect(out.get("tse_a")).toMatchObject({
      tokens: COUNTS,
      cacheHitRate: 0.75,
    });
    expect(out.get("tse_b")).toMatchObject({
      cost: null,
      tokens: COUNTS,
      cacheHitRate: null,
    });
    expect(schema.runTotals.tokens.name).toBe("tokens");
  });
});

describe("list_runs: tokens", () => {
  it("carries each row's counts from its rollup, and null where there is none", async () => {
    const stores = memoryStores(
      [
        ledgerRun({
          publicId: "arun_priced",
          runId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
          cost: rollupCostRow(),
        }),
      ],
      [tachoSession({ publicId: "tse_none" })],
    );
    const list = createRunListHandler({
      ...stores,
      readRunRollups: async (scope, ids) => {
        const found = await stores.readRunRollups(scope, ids);
        const priced = found.get("arun_priced");
        if (priced)
          found.set("arun_priced", {
            ...priced,
            tokens: COUNTS,
            cacheHitRate: 0.6,
          });
        return found;
      },
    });
    const runs = (await list({ limit: 50 }, ctx())).runs;
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(byId.arun_priced).toMatchObject({
      tokens: COUNTS,
      cacheHitRate: 0.6,
    });
    expect(byId.tse_none).toMatchObject({ tokens: null, cacheHitRate: null });
  });
});
