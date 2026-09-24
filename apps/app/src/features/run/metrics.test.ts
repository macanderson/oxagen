// The one derivation: every figure from the record the page holds, and null
// for a figure it does not carry. The tests hold the reconciliations the page
// promises (the Tokens figure to the classes, the in and out split to the
// classes) and the refusals (no rollup, no transcript, no price book).
import { describe, expect, it } from "vitest";
import { readError, readOk } from "@/data/read";
import type { TranscriptEntry } from "@/data/contracts/run";
import type { PriceBook } from "@/data/contracts/spend";
import { runMetrics } from "./metrics";
import {
  mockupTranscript,
  runCost,
  runRow,
  transcriptEntry,
} from "./run.builders";

const book = (rates: Record<string, string>): PriceBook => ({
  at: "2026-09-15T00:00:00.000Z",
  entries: Object.entries(rates).map(([tokenClass, micros]) => ({
    provider: "anthropic",
    model: "claude-opus-5",
    modelAliases: [],
    region: null,
    tokenClass: tokenClass as PriceBook["entries"][number]["tokenClass"],
    unit: "token" as const,
    ratePerMillion: { micros, currency: "USD" },
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    source: "list" as const,
    negotiated: false,
  })),
});

const RATES = {
  input_uncached: "15000000",
  cache_read: "1500000",
  cache_write_5m: "18750000",
  cache_write_1h: "30000000",
  output: "75000000",
  reasoning: "75000000",
};

describe("runMetrics", () => {
  it("splits the tokens into in and out that sum to the total of the classes", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: null,
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
    expect(m.priced).toBeNull();
  });

  it("prices each class from the book and says what the cache saved against uncached input", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: book(RATES),
    });
    // 91,022 cache reads at $15.00 less $1.50 per million: $1.228797.
    expect(m.priced?.cacheSaved).toEqual({
      micros: "1228797",
      currency: "USD",
    });
    expect(m.priced?.byClass.cache_read).toEqual({
      micros: "136533",
      currency: "USD",
    });
    // A class the run spent nothing in costs nothing.
    expect(m.priced?.byClass.cache_write_1h?.micros).toBe("0");
  });

  it("leaves a class unpriced when the book has no row for it, never a partial sum", () => {
    const { output: _drop, ...rest } = RATES;
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: book(rest),
    });
    expect(m.priced?.byClass.output).toBeNull();
    expect(m.priced?.byClass.reasoning).not.toBeNull();
  });

  it("counts the operator's prompts and calls every one after the first corrective", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: null,
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
      book: null,
    });
    expect(m.prompts).toEqual({ count: 1, corrective: 0 });
  });

  it("reads the per-turn ledger and the tool calls off the transcript", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: null,
    });
    expect(m.turns?.map((turn) => turn.turn)).toEqual([1, 2]);
    expect(m.turns?.[0]?.cost).toEqual({ micros: "380000", currency: "USD" });
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
      book: null,
    });
    expect(sealed.wall.ms).toBe(3_300_000);
    expect(sealed.wall.sealed).toBe(true);
    const live = runMetrics({
      run: runRow({ status: "live", sealedAt: null }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: null,
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
      book: null,
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
      book: null,
    });
    expect(m.tokens).toBeNull();
    expect(m.cost).toBeNull();
    expect(m.wasted).toBeNull();
    expect(m.prompts).toBeNull();
    expect(m.wall.ms).toBeNull();
    expect(m.turns).toBeNull();
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
      book: null,
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

function usage(
  inputUncached: number | null,
  cacheRead: number | null,
): TranscriptEntry["usage"] {
  return {
    inputUncached,
    cacheRead,
    cacheWrite: null,
    output: null,
    reasoning: null,
  };
}

describe("runMetrics over a partial record", () => {
  it("says nothing about the cache's saving when the book cannot price a cache read against uncached input (negative)", () => {
    const { cache_read: _read, ...noCacheRate } = RATES;
    const noRead = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: book(noCacheRate),
    });
    expect(noRead.priced?.cacheSaved).toBeNull();
    expect(noRead.priced?.byClass.cache_read).toBeNull();
    const { input_uncached: _fresh, ...noFreshRate } = RATES;
    const noFresh = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: book(noFreshRate),
    });
    expect(noFresh.priced?.cacheSaved).toBeNull();
    // The rate it can price is still priced.
    expect(noFresh.priced?.byClass.cache_read).toEqual({
      micros: "136533",
      currency: "USD",
    });
  });

  it("prices from a book row that names the model by alias, and passes over regional and non-token rows", () => {
    const row = (
      overrides: Partial<PriceBook["entries"][number]>,
    ): PriceBook["entries"][number] => ({
      provider: "anthropic",
      model: "claude-opus-5-20260101",
      modelAliases: ["claude-opus-5"],
      region: null,
      tokenClass: "output",
      unit: "token",
      ratePerMillion: { micros: "75000000", currency: "USD" },
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      source: "list",
      negotiated: false,
      ...overrides,
    });
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: {
        at: "2026-09-15T00:00:00.000Z",
        entries: [
          // A regional rate and a rate per request are not the run's rate.
          row({
            region: "eu-west-1",
            ratePerMillion: { micros: "1", currency: "USD" },
          }),
          row({
            unit: "request",
            ratePerMillion: { micros: "2", currency: "USD" },
          }),
          row({}),
        ],
      },
    });
    // 12,004 output tokens at $75.00 a million, from the aliased row.
    expect(m.priced?.byClass.output).toEqual({
      micros: "900300",
      currency: "USD",
    });
    // The book prices no other class, so none of them is priced.
    expect(m.priced?.byClass.input_uncached).toBeNull();
    expect(m.priced?.cacheSaved).toBeNull();
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
      book: null,
    });
    // The first call ran 2s and was never parked; the second ran 62s, 60 of them waiting on a person.
    expect(m.toolCalls?.map((call) => call.ms)).toEqual([2000, 2000]);
    expect(m.wall.parts).toMatchObject({ tool: 4000, waiting: 60_000 });
  });

  it("claims no saving for a run that read nothing from the cache, rather than a saving of zero", () => {
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const tokens = { ...rollup.tokens, cacheRead: 0 };
    const m = runMetrics({
      run: runRow(),
      cost: readOk(
        runCost({
          rollup: {
            ...rollup,
            tokens,
            byModel: rollup.byModel.map((row) => ({ ...row, tokens })),
          },
        }),
      ),
      transcript: readOk(mockupTranscript()),
      book: book(RATES),
    });
    expect(m.priced?.byClass.cache_read).toEqual({
      micros: "0",
      currency: "USD",
    });
    expect(m.priced?.cacheSaved).toBeNull();
  });

  it("prices nothing when the rollup names no model the book could price against (negative)", () => {
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost({ rollup: { ...rollup, byModel: [] } })),
      transcript: readOk(mockupTranscript()),
      book: book(RATES),
    });
    expect(m.priced).toBeNull();
    // The token figures do not depend on the book.
    expect(m.tokens?.total).toBe(128_343);
  });

  it("prices a class nobody spent in as nothing only when the rollup carries a currency to say it in (negative)", () => {
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost({ rollup: { ...rollup, cost: null } })),
      transcript: readOk(mockupTranscript()),
      book: book(RATES),
    });
    // No run spent a 1h cache write, and no currency is recorded to price zero in.
    expect(m.priced?.byClass.cache_write_1h).toBeNull();
    // A class the run did spend in is priced from the book regardless.
    expect(m.priced?.byClass.output).toEqual({
      micros: "900300",
      currency: "USD",
    });
  });

  it("takes the run row's cost when the rollup carries none, and prices the waste against it with its basis", () => {
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const m = runMetrics({
      run: runRow({
        cost: { micros: "1000000", currency: "USD", basis: "estimated" },
      }),
      cost: readOk(runCost({ rollup: { ...rollup, cost: null } })),
      transcript: readOk(mockupTranscript()),
      book: null,
    });
    expect(m.cost).toEqual({
      micros: "1000000",
      currency: "USD",
      basis: "estimated",
    });
    // 29% of $1.00 was not productive.
    expect(m.wasted).toEqual({
      micros: "290000",
      currency: "USD",
      basis: "estimated",
    });
  });

  it("prices the waste as the unproductive share of the rollup's cost, truncated to the micro", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript()),
      book: null,
    });
    // $4.131265 times 0.29 is $1.19806685, which truncates to $1.198066.
    expect(m.wasted).toEqual({
      micros: "1198066",
      currency: "USD",
      basis: "gateway_observed",
    });
  });

  // The contract refuses a ratio outside 0 to 1, so the first two rows guard
  // the derivation against a value only a hand-built rollup can carry.
  it.each<[string, number | null]>([
    ["above one", 1.2],
    ["below zero", -0.1],
    ["not recorded", null],
  ])(
    "claims no wasted spend for a productive ratio %s (negative)",
    (_, productiveRatio) => {
      const rollup = runCost().rollup;
      if (rollup === null) throw new Error("the builder's rollup is present");
      const m = runMetrics({
        run: runRow(),
        cost: readOk(runCost({ rollup: { ...rollup, productiveRatio } })),
        transcript: readOk(mockupTranscript()),
        book: null,
      });
      expect(m.wasted).toBeNull();
      expect(m.cost?.micros).toBe("4131265");
    },
  );

  it("counts the model calls off the transcript when the rollup was not read", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readError("down", 502),
      transcript: readOk(mockupTranscript()),
      book: null,
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
      book: null,
    });
    // 113,328 input tokens over 54 calls is 2,098.67, rounded to 2,099.
    expect(counted.perModelCall).toBe(2099);
    const rollup = runCost().rollup;
    if (rollup === null) throw new Error("the builder's rollup is present");
    const none = runMetrics({
      run: runRow(),
      cost: readOk(runCost({ rollup: { ...rollup, modelCalls: 0 } })),
      transcript: readOk(mockupTranscript()),
      book: null,
    });
    expect(none.perModelCall).toBeNull();
    expect(none.modelCalls).toBe(0);
  });

  it("reads each turn's cache hit from the usage its frames reported, and none where they reported none (negative)", () => {
    const entries = [
      frame(0, 0, { turn: 1 }),
      modelFrame(1, 1, 1, usage(100, 300)),
      modelFrame(2, 2, 1, usage(null, 100)),
      frame(3, 3, { turn: 2 }),
      modelFrame(4, 4, 2, null),
      frame(5, 5, { turn: 3 }),
      modelFrame(6, 6, 3, usage(0, null)),
      frame(7, 7, { turn: 4 }),
      modelFrame(8, 8, 4, undefined),
    ];
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries })),
      book: null,
    });
    expect(m.turns?.map((turn) => turn.cacheHit)).toEqual([
      // 400 read of 500 counted input.
      0.8,
      // A frame with no usage reports nothing.
      null,
      // Usage that counts no input names no hit rate, never 0%.
      null,
      // A frame that carries no usage field at all reports nothing either.
      null,
    ]);
    expect(m.turns?.[0]).toMatchObject({
      steps: 2,
      modelSteps: 2,
      toolSteps: 0,
      frames: 3,
      cost: null,
      seq: "0",
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
      book: null,
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
      book: null,
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
      book: null,
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
      book: null,
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
      book: null,
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
      book: null,
    });
    // The live clock stops at the last frame, the request, so no wait has been recorded.
    expect(m.wall.ms).toBe(4000);
    expect(m.wall.parts?.waiting).toBe(0);
    expect(m.toolCalls?.[0]?.ms).toBe(4000);
  });

  it("keeps a sealed run's wall clock when the transcript read failed, but draws no split of it (negative)", () => {
    const m = runMetrics({
      run: runRow(),
      cost: readOk(runCost()),
      transcript: readError("down", 502),
      book: null,
    });
    expect(m.wall).toEqual({
      ms: 3_300_000,
      sealed: true,
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
      book: null,
    });
    expect(instant.wall).toEqual({
      ms: 0,
      sealed: true,
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
      book: null,
    });
    expect(backwards.wall.ms).toBe(0);
  });

  it("has no clock for a live run that has recorded no frame yet (negative)", () => {
    const m = runMetrics({
      run: runRow({ status: "live", sealedAt: null }),
      cost: readOk(runCost()),
      transcript: readOk(mockupTranscript({ entries: [] })),
      book: null,
    });
    expect(m.wall).toEqual({
      ms: null,
      sealed: false,
      parts: null,
      lead: null,
    });
    expect(m.prompts).toEqual({ count: 0, corrective: 0 });
    expect(m.turns).toEqual([]);
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
      book: null,
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
