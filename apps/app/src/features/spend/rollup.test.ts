// The figures the Spend page derives from the rollup's rows: token classes
// summed at one level, the cache hit rate and reasoning share with no rate
// over nothing, tokens per run, a key's own findings, and the basis a sum of
// costs can honestly carry.
import { describe, expect, it } from "vitest";
import type { Cost } from "@/data/contracts/money";
import type { SpendFinding, SpendReport } from "@/data/contracts/spend";
import {
  basisOf,
  cacheHitRate,
  cacheWriteShare,
  classesOf,
  findingsOn,
  perRun,
  reasoningShare,
  savingOf,
  sumClasses,
  sumCost,
  totalOf,
} from "./rollup";

type Tokens = SpendReport["rows"][number]["tokens"];

const tokens = (over: Partial<Tokens> = {}): Tokens => ({
  input_uncached: 100,
  cache_read: 300,
  cache_write_5m: 20,
  cache_write_1h: 30,
  output: 40,
  reasoning: 10,
  ...over,
});

const cost = (micros: string, basis: Cost["basis"]): Cost => ({
  micros,
  currency: "USD",
  basis,
});

function finding(over: Partial<SpendFinding>): SpendFinding {
  return {
    id: "fnd_1",
    kind: "unpaged_results",
    level: "tool",
    subject: "github__get_issue",
    saving: cost("1000000", "gateway_observed"),
    confidence: "high",
    window: {
      from: "2026-08-16T00:00:00.000Z",
      to: "2026-09-15T00:00:00.000Z",
    },
    why: "why",
    fix: "fix",
    runs: 1,
    calls: 1,
    ...over,
  };
}

describe("token classes", () => {
  it("folds the two cache-write TTLs into one class", () => {
    expect(classesOf(tokens())).toEqual({
      input_uncached: 100,
      cache_read: 300,
      cache_write: 50,
      output: 40,
      reasoning: 10,
    });
  });

  it("sums the rows of one level, and the total is every class together", () => {
    const classes = sumClasses([{ tokens: tokens() }, { tokens: tokens() }]);
    expect(classes.cache_read).toBe(600);
    expect(totalOf(classes)).toBe(1000);
    expect(totalOf(sumClasses([]))).toBe(0);
  });
});

describe("rates", () => {
  it("reads the cache hit rate token-weighted over input", () => {
    expect(cacheHitRate(classesOf(tokens()))).toBe(0.75);
  });

  it("reads a rebuilt cache as the share of input written to it, beside a hit rate that leaves writes out (A-08)", () => {
    // Little fresh input, a high hit rate, and as much written as read.
    const rebuilt = classesOf(
      tokens({
        input_uncached: 5_000,
        cache_read: 395_000,
        cache_write_5m: 300_000,
        cache_write_1h: 100_000,
      }),
    );
    expect(cacheHitRate(rebuilt)).toBeCloseTo(0.9875);
    expect(cacheWriteShare(rebuilt)).toBe(0.5);
    // 50 written of 450 input tokens.
    expect(cacheWriteShare(classesOf(tokens()))).toBeCloseTo(50 / 450);
  });

  it("answers no rate over nothing, never a zero (negative)", () => {
    const none = classesOf(
      tokens({
        input_uncached: 0,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        output: 0,
        reasoning: 0,
      }),
    );
    expect(cacheHitRate(none)).toBeNull();
    expect(cacheWriteShare(none)).toBeNull();
    expect(reasoningShare(none)).toBeNull();
  });

  it("reads reasoning as a share of completion tokens", () => {
    expect(reasoningShare(classesOf(tokens()))).toBe(0.2);
  });

  it("rounds tokens per run and answers none for a row with no run", () => {
    expect(perRun(275, 12)).toBe(23);
    expect(perRun(275, 0)).toBeNull();
  });
});

describe("a key's findings", () => {
  const list = [
    finding({ id: "fnd_1" }),
    finding({ id: "fnd_2", saving: cost("500000", "gateway_observed") }),
    finding({ id: "fnd_3", level: "agent", subject: "github__get_issue" }),
  ];

  it("keeps only the findings whose level and subject name the key", () => {
    expect(
      findingsOn(list, "tool", "github__get_issue").map((f) => f.id),
    ).toEqual(["fnd_1", "fnd_2"]);
  });

  it("sums their savings with the basis they share, and answers none for no finding", () => {
    expect(savingOf(findingsOn(list, "tool", "github__get_issue"))).toEqual(
      cost("1500000", "gateway_observed"),
    );
    expect(savingOf([])).toBeNull();
  });
});

describe("the basis of a sum", () => {
  it("is never stronger than a part", () => {
    expect(
      basisOf([cost("1", "gateway_observed"), cost("1", "client_attested")]),
    ).toBe("mixed");
    expect(
      basisOf([cost("1", "gateway_observed"), cost("1", "estimated")]),
    ).toBe("estimated");
    expect(basisOf([cost("1", "gateway_observed"), cost("1", null)])).toBe(
      null,
    );
  });

  it("sums the money exactly and answers none for no part", () => {
    expect(
      sumCost([cost("9007199254740993", "mixed"), cost("2", "mixed")]),
    ).toEqual(cost("9007199254740995", "mixed"));
    expect(sumCost([])).toBeNull();
  });
});
