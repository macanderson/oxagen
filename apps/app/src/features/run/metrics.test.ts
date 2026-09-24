// The one derivation: every figure from the record the page holds, and null
// for a figure it does not carry. The tests hold the reconciliations the page
// promises (the Tokens figure to the classes, the in and out split to the
// classes) and the refusals (no rollup, no transcript, no price book).
import { describe, expect, it } from "vitest";
import { readError, readOk } from "@/data/read";
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
