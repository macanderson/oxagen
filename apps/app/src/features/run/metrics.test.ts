// The one derivation: every figure from the record the page holds, and null
// for a figure it does not carry. The tests hold the reconciliations the page
// promises (the Tokens figure to the classes, the in and out split to the
// classes, the class costs to the rollup's recorded cost) and the refusals (no
// rollup, no transcript, no recorded split or saving). It reads no price book:
// every cost is the one the rollup recorded (#4069).
import { describe, expect, it } from "vitest";
import { readError, readOk } from "@/data/read";
import { sumMoney } from "@/data/contracts/money";
import type { RunCostRollup, TranscriptEntry } from "@/data/contracts/run";
import { runMetrics, TOKEN_CLASSES, turnFigures } from "./metrics";
import {
  mockupTranscript,
  runCost,
  runRow,
  transcriptEntry,
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

  it("counts the operator's prompts and calls every one after the first corrective", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect(m.prompts).toEqual({ count: 2, corrective: 1 });
  });

  it("counts neither a model request nor a subagent's turn as the operator prompting (negative)", () => {
    // The contract's `prompt` kind is the request half of a model call, and a
    // subagent's turn opens on words its parent sent. Neither is the operator.
    const entries = mockupTranscript().entries.map((entry) =>
      entry.type === "turn_start" && entry.turn === 2
        ? {
            ...entry,
            subagent: {
              chainRef: "0192d4a8-7c1e-7a00-8000-0000000000c1",
              type: "Explore",
            },
          }
        : entry.type === "model.request"
          ? { ...entry, kinds: [...entry.kinds, "prompt" as const] }
          : entry,
    );
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    expect(m.prompts).toEqual({ count: 1, corrective: 0 });
  });

  it("reads the tool calls off the transcript, and leaves the per-turn ledger to get_run_turns", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
    });
    expect("turns" in m).toBe(false);
    expect(m.toolCalls?.map((call) => call.name)).toEqual([
      "list_pull_requests",
      "create_tag",
    ]);
    expect(m.toolCalls?.[1]?.failed).toBe(true);
    expect(m.families?.[0]?.calls).toBe(2);
    expect(m.batches?.count).toBe(2);
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

  it("counts a parked call's wait as the person's, not the tool's", () => {
    const entry = (
      seq: number,
      type: string,
      kind: "tool_call" | "frame",
      label: string,
      atS: number,
    ) =>
      transcriptEntry({
        seq: String(seq),
        endSeq: String(seq),
        type,
        kind,
        label,
        turn: 1,
        frames: 1,
        request: null,
        response: null,
        callKey: "call_1",
        at: new Date(
          Date.parse("2026-09-15T08:00:00.000Z") + atS * 1000,
        ).toISOString(),
        elapsedMs: atS * 1000,
        cost: null,
        cumulativeCost: null,
      });
    const entries = [
      entry(1, "tool_requested", "tool_call", "create_release", 0),
      entry(
        2,
        "approval_request",
        "frame",
        "approval_request create_release",
        1,
      ),
      entry(3, "approval_decision", "frame", "approve create_release", 601),
      entry(4, "tool_call", "tool_call", "create_release ok", 603),
    ];
    const m = runMetrics({
      run: runRow({
        startedAt: "2026-09-15T08:00:00.000Z",
        sealedAt: "2026-09-15T08:10:03.000Z",
      }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    expect(m.wall.parts?.waiting).toBe(600_000);
    expect(m.wall.parts?.tool).toBe(3_000);
    expect(m.wall.lead).toBe("waiting");
    expect(m.toolCalls?.[0]?.ms).toBe(3_000);
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

  it("marks the counts as floors when the transcript stops short of the run", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(
        mockupTranscript({ cursor: "next", entries: [transcriptEntry()] }),
      ),
    });
    expect(m.whole).toBe(false);
  });
});

/** The instant the hand-built transcripts below start at. */
const T0 = Date.parse("2026-09-15T08:00:00.000Z");

/**
 * One frame with nothing on it but what a test names: no halves, no cost, no
 * call key, one frame, in turn 1. `atS` is seconds from T0.
 */
function frame(
  seq: number,
  atS: number,
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return transcriptEntry({
    seq: String(seq),
    endSeq: String(seq),
    at: new Date(T0 + atS * 1000).toISOString(),
    elapsedMs: atS * 1000,
    kind: "frame",
    type: "turn_start",
    label: "turn_start",
    callKey: null,
    kinds: [],
    request: null,
    response: null,
    decision: null,
    frames: 1,
    turn: 1,
    cost: null,
    cumulativeCost: null,
    ...overrides,
  });
}

/** A model call's one frame, with the token counts it reported. */
function modelFrame(
  seq: number,
  atS: number,
  turn: number,
  usage: TranscriptEntry["usage"],
): TranscriptEntry {
  return frame(seq, atS, {
    kind: "model_call",
    type: "llm_call",
    label: "anthropic/claude-opus-5",
    turn,
    usage,
  });
}

/** A tool call the producer wrote as one frame: the whole exchange, no request half. */
function toolFrame(seq: number, atS: number, label: string, turn = 1) {
  return frame(seq, atS, { kind: "tool_call", type: "tool_call", label, turn });
}

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

  it("takes a wait off only the call it fell inside", () => {
    const entries = [
      frame(0, 0, {
        kind: "tool_call",
        type: "tool_requested",
        label: "list_pull_requests",
        callKey: "a",
      }),
      frame(1, 2, {
        kind: "tool_call",
        type: "tool_call",
        label: "list_pull_requests ok",
        callKey: "a",
      }),
      frame(2, 3, {
        kind: "tool_call",
        type: "tool_requested",
        label: "create_release",
        callKey: "b",
      }),
      frame(3, 4, {
        type: "approval_request",
        label: "approval_request create_release",
        callKey: "b",
      }),
      frame(4, 64, {
        type: "approval_decision",
        label: "approve create_release",
        callKey: "b",
      }),
      frame(5, 65, {
        kind: "tool_call",
        type: "tool_call",
        label: "create_release ok",
        callKey: "b",
      }),
    ];
    const m = runMetrics({
      run: runRow({
        startedAt: "2026-09-15T08:00:00.000Z",
        sealedAt: "2026-09-15T08:01:05.000Z",
      }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    // The first call ran 2s and was never parked; the second ran 62s, 60 of them waiting on a person.
    expect(m.toolCalls?.map((call) => call.ms)).toEqual([2000, 2000]);
    expect(m.wall.parts).toMatchObject({ tool: 4000, waiting: 60_000 });
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

  it("counts the model calls off the transcript when the rollup was not read", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readError("down", 502),
      transcript: readOk(mockupTranscript()),
    });
    // The request and response of turn 1 are one call; turn 2's llm_call is the other.
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

  it("gives a one-frame tool call no wall time of its own, and sums families and the serial time without it", () => {
    const entries = [
      frame(0, 0),
      modelFrame(1, 1, 1, null),
      // Emitted shell first; the families sort by count, then by name.
      toolFrame(2, 2, "Bash ok"),
      toolFrame(3, 5, "Read ok"),
    ];
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    expect(m.toolCalls?.map((call) => [call.name, call.ms])).toEqual([
      ["Bash", null],
      ["Read", null],
    ]);
    expect(m.families?.map((family) => [family.group, family.ms])).toEqual([
      ["read", 0],
      ["shell", 0],
    ]);
    expect(m.families?.[0]?.share).toBe(0.5);
    expect(m.batches).toMatchObject({
      count: 1,
      parallel: 1,
      widest: 2,
      fanOut: 2,
      serialMs: 0,
      // From the first call's start to the last call's end: 2s to 5s.
      togetherMs: 3000,
    });
    expect(m.batches?.histogram.get(2)).toBe(1);
  });

  it("counts a failed tool call by its status word and files it under its family's failures", () => {
    const entries = [
      frame(0, 0),
      modelFrame(1, 1, 1, null),
      toolFrame(2, 2, "Bash error"),
      toolFrame(3, 3, "Bash ok"),
    ];
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    expect(m.toolCalls?.map((call) => call.failed)).toEqual([true, false]);
    expect(m.families).toEqual([
      { group: "shell", calls: 2, share: 1, ms: 0, failed: 1, tools: 1 },
    ]);
  });

  it("closes a batch at a turn boundary even when no model step sits between the calls", () => {
    const entries = [
      frame(0, 0, { turn: 1 }),
      toolFrame(1, 1, "Bash ok", 1),
      frame(2, 2, { turn: 2 }),
      toolFrame(3, 3, "Bash ok", 2),
    ];
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    expect(m.toolCalls?.map((call) => call.batch)).toEqual([0, 1]);
    expect(m.batches).toMatchObject({
      count: 2,
      parallel: 0,
      widest: 1,
      fanOut: 1,
    });
    expect(m.batches?.histogram.get(1)).toBe(2);
  });

  it("has no batches, and no family, for a run that called no tool (negative)", () => {
    const entries = [frame(0, 0), modelFrame(1, 1, 1, null)];
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    expect(m.toolCalls).toEqual([]);
    expect(m.families).toEqual([]);
    expect(m.batches).toBeNull();
  });

  it("counts the entries the transcript files under errors", () => {
    const entries = [
      frame(0, 0),
      toolFrame(1, 1, "Bash error"),
      frame(2, 2, {
        type: "agent_stop",
        label: "agent_stop",
        kinds: ["errors"],
      }),
      frame(3, 3, { type: "hook", label: "hook", kinds: ["errors", "tools"] }),
    ];
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    expect(m.errors).toBe(2);
  });

  it("counts no wait yet for a call still parked at the end of the record", () => {
    const entries = [
      frame(0, 0, {
        kind: "tool_call",
        type: "tool_requested",
        label: "create_release",
        callKey: "call_1",
      }),
      frame(1, 4, {
        type: "approval_request",
        label: "approval_request create_release",
        callKey: "call_1",
      }),
    ];
    const m = runMetrics({
      run: runRow({ status: "live", sealedAt: null }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
    });
    // The live clock stops at the last frame, the request, so no wait has been recorded.
    expect(m.wall.ms).toBe(4000);
    expect(m.wall.parts?.waiting).toBe(0);
    expect(m.toolCalls?.[0]?.ms).toBe(4000);
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
      parts: null,
      lead: null,
    });
    expect(m.prompts).toEqual({ count: 0, corrective: 0 });
    expect(m.modelCalls).toBe(54);
  });

  it("names the harness as the lead when nothing the record timed accounts for the clock", () => {
    const entries = [frame(0, 0), frame(1, 30, { type: "turn_end" })];
    const m = runMetrics({
      run: runRow({
        startedAt: "2026-09-15T08:00:00.000Z",
        sealedAt: "2026-09-15T08:01:00.000Z",
      }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
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
