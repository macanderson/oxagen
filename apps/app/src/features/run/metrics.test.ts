// The one derivation: every figure from the record the page holds, and null
// for a figure it does not carry. The tests hold the reconciliations the page
// promises (the Tokens figure to the classes, the in and out split to the
// classes, the class costs to the rollup's recorded cost) and the refusals (no
// rollup, no transcript, no recorded split or saving). It reads no price book:
// every cost is the one the rollup recorded (#4069).
//
// The prompts, steps, calls, families, batches and the parts of the wall
// clock are the server's, counted over the run's steps (ADR-182); how they
// are counted is tested in `packages/run-ledger/src/transcript-figures.test.ts`.
// Here they are only shaped, and the clock they are parts of is worked out.
import { describe, expect, it } from "vitest";
import { readError, readOk } from "@/data/read";
import { sumMoney } from "@/data/contracts/money";
import type { RunCost, RunCostRollup } from "@/data/contracts/run";
import {
  provisionalCost,
  runMetrics,
  TOKEN_CLASSES,
  turnFigures,
} from "./metrics";
import {
  mockupTranscript,
  runCost,
  runRow,
  transcriptEntry,
  transcriptFigures,
} from "./run.builders";

/** The builder's rollup, which carries one model's recorded split and saving. */
function builderRollup(): RunCostRollup {
  const rollup = runCost().rollup;
  if (rollup === null) throw new Error("the builder's rollup is present");
  return rollup;
}

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});

/** One model's row of `get_run_cost`'s provisional figures. */
type ProvisionalRow = NonNullable<RunCost["provisional"]>["byModel"][number];

describe("runMetrics", () => {
  it("splits the tokens into in and out that sum to the total of the classes", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    // The builder's rollup: 18,204 + 91,022 + 4,102 + 0 in, 12,004 + 3,011 out.
    expect(m.tokens?.input).toBe(113_328);
    expect(m.tokens?.output).toBe(15_015);
    expect(m.tokens?.total).toBe(113_328 + 15_015);
    const sum = Object.values(m.tokens?.byClass ?? {}).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(m.tokens?.total);
  });

  it("takes each class's cost and the cache's saving from what the rollup recorded, and they sum to its cost", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    // The builder's model recorded a $1.228797 saving and $0.136533 of cache reads.
    expect(m.priced?.cacheSaved).toEqual({
      micros: "1228797",
      currency: "USD",
    });
    expect(m.priced?.byClass.cache_read).toMatchObject({
      micros: "136533",
      currency: "USD",
    });
    // A class the run spent nothing in costs nothing.
    expect(m.priced?.byClass.cache_write_1h?.micros).toBe("0");
    expect(m.priced?.hasUnpriced).toBe(false);
    // The six recorded classes add up to the rollup's cost, to the micro.
    const classes = TOKEN_CLASSES.map((tokenClass) => {
      const part = m.priced?.byClass[tokenClass];
      if (part == null) throw new Error(`${tokenClass} has a recorded cost`);
      return part;
    });
    expect(sumMoney(classes)?.micros).toBe(builderRollup().cost?.micros);
  });

  it("sums the models' recorded splits, and leaves a class without a cost when a model spent in it with no split recorded, never a partial sum", () => {
    const rollup = builderRollup();
    const opus = rollup.byModel[0];
    if (opus === undefined) throw new Error("the builder has one model");
    const tokens = {
      inputUncached: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 500,
      reasoning: 0,
    };
    const priced = {
      ...opus,
      model: "claude-haiku-4-5",
      calls: 1,
      cost: usd("2500"),
      tokens,
      costByClass: {
        inputUncached: usd("0"),
        cacheRead: usd("0"),
        cacheWrite5m: usd("0"),
        cacheWrite1h: usd("0"),
        output: usd("2500"),
        reasoning: usd("0"),
      },
      cacheSaving: usd("0"),
      hasUnpriced: false,
    };
    const two = runMetrics({
      run: runRow(),
      cost: readOk(runCost({ rollup: { ...rollup, byModel: [opus, priced] } })),
      transcript: readOk(mockupTranscript()),
    });
    // $2.034842 recorded for the first model's output, $0.0025 for the second's.
    expect(two.priced?.byClass.output?.micros).toBe("2037342");
    const unpriced = {
      ...priced,
      cost: null,
      costByClass: null,
      cacheSaving: null,
      hasUnpriced: true,
    };
    const m = runMetrics({
      run: runRow(),
      cost: readOk(
        runCost({ rollup: { ...rollup, byModel: [opus, unpriced] } }),
      ),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.priced?.byClass.output).toBeNull();
    // The second model spent nothing in the other classes, so they stand.
    expect(m.priced?.byClass.reasoning?.micros).toBe("560000");
    // It read nothing from the cache either, so the first model's saving stands.
    expect(m.priced?.cacheSaved?.micros).toBe("1228797");
    expect(m.priced?.hasUnpriced).toBe(true);
  });

  it("reads the operator's prompts from the server and calls every one after the first corrective", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.prompts).toEqual({ count: 2, corrective: 1 });
  });

  it("shapes the server's tool call figures: the calls, the families and the batches", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.toolCalls).toEqual({
      count: 2,
      failed: 1,
      tools: [
        { name: "create_tag", calls: 1 },
        { name: "list_pull_requests", calls: 1 },
      ],
    });
    expect(m.families).toEqual([
      { group: "tool", calls: 2, share: 1, ms: 2000, failed: 1, tools: 2 },
    ]);
    expect(m.batches).toMatchObject({ count: 2, parallel: 0, widest: 1 });
    // The histogram is keyed by how many calls a batch held.
    expect(m.batches?.histogram.get(1)).toBe(2);
    expect(m.batches?.histogram.get(2)).toBeUndefined();
  });

  it("takes a sealed run's wall clock from start to seal, and a live run's from its last frame", () => {
    const sealed = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(sealed.wall.ms).toBe(3_300_000);
    expect(sealed.wall.sealed).toBe(true);
    const live = runMetrics({
      run: runRow({ status: "live", sealedAt: null }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(live.wall.ms).toBe(24_000);
    expect(live.wall.sealed).toBe(false);
  });

  it("takes the model, tool and waiting parts from the server and leaves the rest of the clock to the harness", () => {
    const m = runMetrics({
      run: runRow({
        startedAt: "2026-09-15T08:00:00.000Z",
        sealedAt: "2026-09-15T08:10:03.000Z",
      }),
      cost: readOk(runCost()),
      transcript: readOk(
        mockupTranscript({
          figures: transcriptFigures({
            wall: { modelMs: 1_000, toolMs: 2_000, waitingMs: 600_000 },
          }),
        }),
      ),
    });
    expect(m.wall.parts).toEqual({
      model: 1_000,
      tool: 2_000,
      waiting: 600_000,
      harness: 0,
    });
    expect(m.wall.lead).toBe("waiting");
  });

  it("answers null for every figure a failed read cannot back, never a zero (negative)", () => {
    const m = runMetrics({
      run: runRow({ cost: null, sealedAt: null, status: "live" }),
      cost: readError("down", 502),
      transcript: readError("down", 502),
    });
    expect(m.tokens).toBeNull();
    expect(m.cost).toBeNull();
    expect(m.prompts).toBeNull();
    expect(m.wall.ms).toBeNull();
    expect(m.toolCalls).toBeNull();
    expect(m.errors).toBeNull();
  });

  it("answers null for every figure a read that carried none cannot back (negative)", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ figures: null })),
    });
    expect(m.prompts).toBeNull();
    expect(m.toolCalls).toBeNull();
    expect(m.families).toBeNull();
    expect(m.batches).toBeNull();
    expect(m.wall.parts).toBeNull();
    // The clock itself is the run row's, so it stands.
    expect(m.wall.ms).toBe(3_300_000);
  });

  it("marks the counts as floors when the run passed the read's frame cap", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ complete: false })),
    });
    expect(m.whole).toBe(false);
    // A later page to read is no floor: the server counted the whole run.
    const paged = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ cursor: "next" })),
    });
    expect(paged.whole).toBe(true);
  });
});

describe("runMetrics over a partial record", () => {
  it("says the cache's saving is not recorded on a row rolled up before savings were, never a zero (negative)", () => {
    const rollup = builderRollup();
    const m = runMetrics({
      run: runRow(),
      cost: readOk(
        runCost({
          rollup: {
            ...rollup,
            byModel: rollup.byModel.map((row) => ({
              ...row,
              cacheSaving: null,
            })),
          },
        }),
      ),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.priced?.cacheSaved).toBeNull();
    // The class split was recorded, so it stands.
    expect(m.priced?.byClass.cache_read?.micros).toBe("136533");
  });

  it("marks the figures incomplete when the rollup could not price some call (negative)", () => {
    const rollup = builderRollup();
    const m = runMetrics({
      run: runRow(),
      cost: readOk(
        runCost({
          rollup: {
            ...rollup,
            byModel: rollup.byModel.map((row) => ({
              ...row,
              hasUnpriced: true,
            })),
          },
        }),
      ),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.priced?.hasUnpriced).toBe(true);
    // What was recorded is still shown, marked, rather than dropped.
    expect(m.priced?.byClass.output?.micros).toBe("2034842");
  });

  it("claims no saving for a run that read nothing from the cache, rather than a saving of zero", () => {
    const rollup = builderRollup();
    const tokens = { ...rollup.tokens, cacheRead: 0 };
    const m = runMetrics({
      run: runRow(),
      cost: readOk(
        runCost({
          rollup: {
            ...rollup,
            tokens,
            byModel: rollup.byModel.map((row) => ({
              ...row,
              tokens,
              costByClass:
                row.costByClass === null
                  ? null
                  : { ...row.costByClass, cacheRead: usd("0") },
              // A rollup records a zero saving for a model that read nothing.
              cacheSaving: usd("0"),
            })),
          },
        }),
      ),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.priced?.byClass.cache_read).toEqual({
      micros: "0",
      currency: "USD",
    });
    // A model that read nothing saved nothing, so no saving is claimed.
    expect(m.priced?.cacheSaved).toBeNull();
  });

  it("shows no class cost when the rollup names no model to take one from (negative)", () => {
    const rollup = builderRollup();
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost({ rollup: { ...rollup, byModel: [] } })),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.priced).toBeNull();
    // The token figures do not depend on the per-model rows.
    expect(m.tokens?.total).toBe(128_343);
  });

  it("costs a class nobody spent in as nothing only when the rollup carries a currency to say it in (negative)", () => {
    const rollup = builderRollup();
    const m = runMetrics({
      run: runRow(),
      cost: readOk(
        runCost({
          rollup: {
            ...rollup,
            cost: null,
            // The rollup priced none of the model's calls.
            byModel: rollup.byModel.map((row) => ({
              ...row,
              cost: null,
              costByClass: null,
              cacheSaving: null,
              hasUnpriced: true,
            })),
          },
        }),
      ),
      transcript: readOk(mockupTranscript()),
    });
    // No run spent a 1h cache write, and no currency is recorded to say zero in.
    expect(m.priced?.byClass.cache_write_1h).toBeNull();
    // A class the run did spend in has no recorded cost to show.
    expect(m.priced?.byClass.output).toBeNull();
  });

  it("keeps an estimated frame's cost, which the rollup files under output, for a model that counted no output tokens", () => {
    const rollup = builderRollup();
    const opus = rollup.byModel[0];
    if (opus === undefined) throw new Error("the builder has one model");
    const estimated = {
      ...opus,
      model: "gpt-5",
      calls: 1,
      cost: { ...usd("7000"), basis: "estimated" as const },
      tokens: {
        inputUncached: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        reasoning: 0,
      },
      costByClass: {
        inputUncached: usd("0"),
        cacheRead: usd("0"),
        cacheWrite5m: usd("0"),
        cacheWrite1h: usd("0"),
        output: usd("7000"),
        reasoning: usd("0"),
      },
      cacheSaving: usd("0"),
      hasUnpriced: false,
    };
    const m = runMetrics({
      run: runRow(),
      cost: readOk(
        runCost({ rollup: { ...rollup, byModel: [opus, estimated] } }),
      ),
      transcript: readOk(mockupTranscript()),
    });
    // $2.034842 for the first model's output and the second's $0.007 estimate.
    expect(m.priced?.byClass.output?.micros).toBe("2041842");
  });

  it("takes the run row's cost when the rollup carries none", () => {
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const m = runMetrics({
      run: runRow({
        cost: { micros: "1000000", currency: "USD", basis: "estimated" },
      }),
      cost: readOk(runCost({ rollup: { ...rollup, cost: null } })),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.cost).toEqual({
      micros: "1000000",
      currency: "USD",
      basis: "estimated",
    });
  });

  // The contract calls the ratio the share of steps that advanced the task and
  // never says it is weighted by cost, so cost x (1 - ratio) would be a guess
  // printed as money. The ratio passes through; no wasted figure is derived.
  it.each<[string, number | null]>([
    ["recorded", 0.71],
    ["zero", 0],
    ["one", 1],
    ["not recorded", null],
  ])(
    "derives no wasted spend from a productive ratio %s (negative)",
    (_, productiveRatio) => {
      const rollup = runCost().rollup;
      if (rollup === null) throw new Error("the builder's rollup is present");
      const m = runMetrics({
        run: runRow(),
        cost: readOk(runCost({ rollup: { ...rollup, productiveRatio } })),
        transcript: readOk(mockupTranscript()),
      });
      expect(m).not.toHaveProperty("wasted");
      expect(m.productiveRatio).toBe(productiveRatio);
      expect(m.cost?.micros).toBe("4131265");
    },
  );

  it("takes the model calls from the server's steps when the rollup was not read", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readError("down", 502),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.modelCalls).toBe(2);
    expect(m.tokens).toBeNull();
    expect(m.priced).toBeNull();
    expect(m.cacheHit).toBeNull();
    expect(m.perModelCall).toBeNull();
    // The run row's cost stands in for the rollup's.
    expect(m.cost).toEqual(runRow().cost);
  });

  it("divides the input tokens over the rollup's model calls, and answers nothing over none (negative)", () => {
    const counted = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    // 113,328 input tokens over 54 calls is 2,098.67, rounded to 2,099.
    expect(counted.perModelCall).toBe(2099);
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const none = runMetrics({
      run: runRow(),
      cost: readOk(runCost({ rollup: { ...rollup, modelCalls: 0 } })),
      transcript: readOk(mockupTranscript()),
    });
    expect(none.perModelCall).toBeNull();
    expect(none.modelCalls).toBe(0);
  });

  it("reads each turn's cache hit from the input its calls reported, and none where they reported none (negative)", () => {
    const row = (
      turn: number,
      tokens: { inputUncached: number | null; cacheRead: number | null },
    ) => ({
      turn,
      seq: String(turn * 10),
      at: "2026-09-15T08:00:00.000Z",
      frames: 3,
      modelSteps: 2,
      toolSteps: 1,
      cost: null,
      cumulativeCost: null,
      tokens,
    });
    const figures = turnFigures([
      row(1, { inputUncached: 100, cacheRead: 400 }),
      // One class reported: the other counts for nothing, not for a guess.
      row(2, { inputUncached: null, cacheRead: 100 }),
      // No call reported input.
      row(3, { inputUncached: null, cacheRead: null }),
      // Input that counts no token names no hit rate, never 0%.
      row(4, { inputUncached: 0, cacheRead: 0 }),
    ]);
    expect(figures.map((figure) => figure.cacheHit)).toEqual([
      // 400 read of 500 counted input.
      0.8,
      1,
      null,
      null,
    ]);
    expect(figures[0]).toEqual({
      turn: 1,
      steps: 3,
      modelSteps: 2,
      toolSteps: 1,
      frames: 3,
      cost: null,
      cacheHit: 0.8,
      seq: "10",
    });
  });

  it("has no batches, and no family, for a run that called no tool (negative)", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(
        mockupTranscript({
          figures: transcriptFigures({
            calls: {
              count: 0,
              failed: 0,
              tools: [],
              families: [],
              batches: null,
            },
          }),
        }),
      ),
    });
    expect(m.toolCalls).toEqual({ count: 0, failed: 0, tools: [] });
    expect(m.families).toEqual([]);
    expect(m.batches).toBeNull();
  });

  it("counts the entries the server counted as failed or refused", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(
        mockupTranscript({
          counts: {
            kinds: {
              prompt: 2,
              responses: 1,
              thinking: 0,
              tools: 2,
              policy: 2,
              usage: 2,
              recall: 1,
              seal: 0,
              errors: 1,
            },
            entries: 9,
            errors: 2,
            policy: 2,
            frames: null,
          },
        }),
      ),
    });
    expect(m.errors).toBe(2);
  });

  it("runs a live run's clock to the end of its last recorded step when read with no render instant", () => {
    const entries = [
      transcriptEntry({ seq: "0", elapsedMs: 0, durationMs: null }),
      transcriptEntry({ seq: "1", elapsedMs: 4_000, durationMs: 1_500 }),
    ];
    const m = runMetrics({
      run: runRow({ status: "live", sealedAt: null }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    expect(m.wall.ms).toBe(5_500);
  });

  it("runs a live run's clock to the render instant and says where it counts from", () => {
    const run = runRow({ status: "live", sealedAt: null, endedAt: null });
    const now = Date.parse(run.startedAt) + 3 * 86_400_000;
    const m = runMetrics({
      run,
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      now,
    });
    expect(m.wall.ms).toBe(3 * 86_400_000);
    expect(m.wall.ticking).toEqual({
      from: Date.parse(run.startedAt),
      at: now,
    });
    expect(m.wall.sealed).toBe(false);
  });

  it("stops a live run's clock at its last frame when read with no render instant, and never ticks a sealed run (negative)", () => {
    const live = runMetrics({
      run: runRow({ status: "live", sealedAt: null, endedAt: null }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(live.wall.ticking).toBeNull();
    expect(live.wall.ms).toBe(mockupTranscript().entries.at(-1)?.elapsedMs);
    const sealed = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      now: Date.now(),
    });
    expect(sealed.wall.ticking).toBeNull();
  });

  it("has no wall clock for a run Oxagen closed for silence, whatever its row's end says", () => {
    const m = runMetrics({
      run: runRow({ sealSource: "idle_timeout" }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.wall).toEqual({
      ms: null,
      sealed: true,
      closedIdle: true,
      ticking: null,
      parts: null,
      lead: null,
    });
  });

  it("calls an open run's cost an estimate, and a sealed run's final once the rollup priced it sealed", () => {
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const estimateOf = (
      run: Parameters<typeof runRow>[0],
      isEstimate: boolean | undefined,
    ) =>
      runMetrics({
        run: runRow(run),
        cost: readOk(runCost({ rollup: { ...rollup, isEstimate } })),
        transcript: readOk(mockupTranscript()),
      }).costIsEstimate;
    expect(estimateOf({ sealedAt: null }, false)).toBe(true);
    expect(estimateOf({}, true)).toBe(true);
    expect(estimateOf({}, false)).toBe(false);
    expect(estimateOf({}, undefined)).toBe(false);
    // With no rollup, the run row's own flag decides.
    const rowOnly = (costIsEstimate: boolean) =>
      runMetrics({
        run: runRow({ costIsEstimate }),
        cost: readOk(runCost({ rollup: null })),
        transcript: readOk(mockupTranscript()),
      }).costIsEstimate;
    expect(rowOnly(true)).toBe(true);
    expect(rowOnly(false)).toBe(false);
  });

  it("keeps a sealed run's wall clock when the transcript read failed, but draws no split of it (negative)", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readError("down", 502),
    });
    expect(m.wall).toEqual({
      ms: 3_300_000,
      sealed: true,
      closedIdle: false,
      ticking: null,
      parts: null,
      lead: null,
    });
    expect(m.whole).toBe(false);
    expect(m.modelCalls).toBe(54);
    expect(m.families).toBeNull();
    expect(m.batches).toBeNull();
  });

  it("draws no split for a run sealed the instant it started, and never a negative clock (negative)", () => {
    const instant = runMetrics({
      run: runRow({
        startedAt: "2026-09-15T08:00:00.000Z",
        sealedAt: "2026-09-15T08:00:00.000Z",
      }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(instant.wall).toEqual({
      ms: 0,
      sealed: true,
      closedIdle: false,
      ticking: null,
      parts: null,
      lead: null,
    });
    const backwards = runMetrics({
      run: runRow({
        startedAt: "2026-09-15T08:00:10.000Z",
        sealedAt: "2026-09-15T08:00:00.000Z",
      }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(backwards.wall.ms).toBe(0);
  });

  it("has no clock for a live run that has recorded no frame yet (negative)", () => {
    const m = runMetrics({
      run: runRow({ status: "live", sealedAt: null }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries: [] })),
    });
    expect(m.wall).toEqual({
      ms: null,
      sealed: false,
      closedIdle: false,
      ticking: null,
      parts: null,
      lead: null,
    });
    expect(m.modelCalls).toBe(54);
  });

  it("names the harness as the lead when nothing the record timed accounts for the clock", () => {
    const m = runMetrics({
      run: runRow({
        startedAt: "2026-09-15T08:00:00.000Z",
        sealedAt: "2026-09-15T08:01:00.000Z",
      }),
      cost: readOk(runCost()),
      transcript: readOk(
        mockupTranscript({
          figures: transcriptFigures({
            wall: { modelMs: 0, toolMs: 0, waitingMs: 0 },
          }),
        }),
      ),
    });
    expect(m.wall.parts).toEqual({
      model: 0,
      tool: 0,
      waiting: 0,
      harness: 60_000,
    });
    expect(m.wall.lead).toBe("harness");
  });
});

describe("provisional spend (#4032)", () => {
  /** What ingest folded from a live wrapped run's `llm_call` frames so far. */
  const provisional = (byModel: ProvisionalRow[]) =>
    readOk(
      runCost({
        rollup: null,
        provisional: {
          byModel,
          toolCalls: 9,
          asOf: "2026-09-15T08:59:00.000Z",
        },
      }),
    );
  const reported = (micros: string) => ({
    micros,
    currency: "USD",
    basis: "client_attested" as const,
  });
  const model = (
    name: string,
    calls: number,
    cost: ProvisionalRow["cost"],
  ): ProvisionalRow => ({
    model: name,
    provider: "anthropic",
    calls,
    cost,
  });
  const live = runRow({ status: "live", sealedAt: null, cost: null });

  it("sums what each model reported, dearest first, before the rollup reaches the run", () => {
    const m = runMetrics({
      run: live,
      cost: provisional([
        model("claude-haiku-5", 3, reported("20000")),
        model("claude-opus-5", 12, reported("1200000")),
      ]),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.provisional?.byModel.map((row) => row.model)).toEqual([
      "claude-opus-5",
      "claude-haiku-5",
    ]);
    expect(m.provisional?.total).toEqual({
      micros: "1220000",
      currency: "USD",
    });
    expect(m.provisional?.partial).toBe(false);
    expect(m.provisional?.toolCalls).toBe(9);
    // Nothing metered the run, so the sum is the cost the page prints.
    expect(provisionalCost(live, m)).toEqual({
      value: { micros: "1220000", currency: "USD" },
      floor: false,
    });
  });

  it("sums only the models that reported a cost, and marks the sum as a floor (negative)", () => {
    const m = runMetrics({
      run: live,
      cost: provisional([
        model("local-llama", 4, null),
        model("claude-opus-5", 12, reported("1200000")),
      ]),
      transcript: readOk(mockupTranscript()),
    });
    // A model with no reported cost sorts after every model with one.
    expect(m.provisional?.byModel.map((row) => row.model)).toEqual([
      "claude-opus-5",
      "local-llama",
    ]);
    expect(m.provisional?.partial).toBe(true);
    expect(provisionalCost(live, m)).toEqual({
      value: { micros: "1200000", currency: "USD" },
      floor: true,
    });
  });

  it("prefers the agent's own report on the run row to the per-model sum", () => {
    const run = runRow({
      status: "live",
      sealedAt: null,
      cost: null,
      reportedCost: reported("2500000"),
    });
    const m = runMetrics({
      run,
      cost: provisional([model("claude-opus-5", 12, reported("1200000"))]),
      transcript: readOk(mockupTranscript()),
    });
    expect(provisionalCost(run, m)).toEqual({
      value: reported("2500000"),
      floor: false,
    });
  });

  it("drops the provisional figures once the rollup has a row, and prints nothing provisional over a metered cost (negative)", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(
        runCost({
          provisional: {
            byModel: [model("claude-opus-5", 12, reported("1200000"))],
            toolCalls: 0,
            asOf: "2026-09-15T08:59:00.000Z",
          },
        }),
      ),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.provisional).toBeNull();
    expect(provisionalCost(runRow(), m)).toBeNull();
  });

  it("carries nothing when the cost read failed or sent no provisional figures (negative)", () => {
    for (const cost of [
      readError("clickhouse_unreachable", 502),
      readOk(runCost({ rollup: null })),
    ]) {
      const m = runMetrics({
        run: live,
        cost,
        transcript: readOk(mockupTranscript()),
      });
      expect(m.provisional).toBeNull();
      expect(provisionalCost(live, m)).toBeNull();
    }
  });
});
