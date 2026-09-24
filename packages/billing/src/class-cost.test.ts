// class-cost.test.ts — the one helper that multiplies a token count by a
// price (#4069): the per-class cost, the cache saving and the write premium.
import { describe, expect, it } from "vitest";
import {
  classesToResolve,
  priceClasses,
  type ResolvedClassEntries,
} from "./class-cost";

/** Sonnet-shaped rates: $3 input, $15 output, $0.30 cache read, $3.75 and $6 writes. */
const ENTRIES: ResolvedClassEntries = {
  input_uncached: { id: "pe_in", microsPerMillion: 3_000_000n },
  cache_read: { id: "pe_cr", microsPerMillion: 300_000n },
  cache_write_5m: { id: "pe_w5", microsPerMillion: 3_750_000n },
  cache_write_1h: { id: "pe_w1", microsPerMillion: 6_000_000n },
  output: { id: "pe_out", microsPerMillion: 15_000_000n },
  reasoning: { id: "pe_out", microsPerMillion: 15_000_000n },
};

describe("classesToResolve", () => {
  it("names every class with units, in class order", () => {
    expect(classesToResolve({ output: 5, input_uncached: 1 })).toEqual([
      "input_uncached",
      "output",
    ]);
  });

  it("adds input_uncached when the cache was read or written with no fresh input", () => {
    expect(classesToResolve({ cache_read: 10, output: 1 })).toEqual([
      "input_uncached",
      "cache_read",
      "output",
    ]);
    expect(classesToResolve({ cache_write_1h: 10 })).toEqual([
      "input_uncached",
      "cache_write_1h",
    ]);
  });

  it("does not add input_uncached when the cache was not touched", () => {
    expect(classesToResolve({ output: 3 })).toEqual(["output"]);
    expect(classesToResolve({})).toEqual([]);
  });
});

describe("priceClasses", () => {
  it("scales each class by its own entry and sums them", () => {
    const p = priceClasses(ENTRIES, {
      input_uncached: 1000,
      cache_read: 2000,
      output: 100,
      reasoning: 50,
    });
    expect(p.scaledByClass).toEqual({
      input_uncached: 3_000_000_000n,
      cache_read: 600_000_000n,
      cache_write_5m: 0n,
      cache_write_1h: 0n,
      output: 1_500_000_000n,
      reasoning: 750_000_000n,
    });
    expect(p.scaled).toBe(5_850_000_000n);
    expect(p.missedClasses).toEqual([]);
    // One entry pricing two classes is named once.
    expect(p.priceEntryIds).toEqual(["pe_in", "pe_cr", "pe_out"]);
  });

  it("names the classes with units and no entry, and prices the rest", () => {
    const p = priceClasses(
      { input_uncached: ENTRIES.input_uncached, reasoning: null },
      { input_uncached: 10, output: 5, reasoning: 5 },
    );
    expect(p.missedClasses).toEqual(["output", "reasoning"]);
    expect(p.scaled).toBe(30_000_000n);
    expect(p.priceEntryIds).toEqual(["pe_in"]);
  });

  it("prices the cache saving as reads at input less reads at cache_read", () => {
    // 2000 × (3_000_000 − 300_000): the reads priced as fresh input, less
    // what they cost as cache reads.
    const p = priceClasses(ENTRIES, { cache_read: 2000 });
    expect(p.cacheSavingScaled).toBe(5_400_000_000n);
  });

  it("measures the saving against input_uncached even when the call sent no fresh input", () => {
    const p = priceClasses(ENTRIES, { cache_read: 1 });
    expect(p.cacheSavingScaled).toBe(2_700_000n);
    // The input entry prices nothing here, so the record does not name it.
    expect(p.priceEntryIds).toEqual(["pe_cr"]);
  });

  it("answers a zero saving with no cache reads, and null when a rate it needs is missing", () => {
    expect(priceClasses(ENTRIES, { output: 1 }).cacheSavingScaled).toBe(0n);
    expect(
      priceClasses({ ...ENTRIES, input_uncached: null }, { cache_read: 10 })
        .cacheSavingScaled,
    ).toBeNull();
    expect(
      priceClasses({ ...ENTRIES, cache_read: undefined }, { cache_read: 10 })
        .cacheSavingScaled,
    ).toBeNull();
  });

  it("prices each write class's premium over fresh input", () => {
    // 100 × (3.75 − 3) + 10 × (6 − 3), a million times the micros.
    const p = priceClasses(ENTRIES, {
      cache_write_5m: 100,
      cache_write_1h: 10,
    });
    expect(p.cacheWritePremiumScaled).toBe(75_000_000n + 30_000_000n);
  });

  it("answers a zero premium with no writes, and null when a write's rate is missing", () => {
    expect(
      priceClasses(ENTRIES, { cache_read: 1 }).cacheWritePremiumScaled,
    ).toBe(0n);
    expect(
      priceClasses(
        { ...ENTRIES, cache_write_1h: null },
        { cache_write_5m: 1, cache_write_1h: 1 },
      ).cacheWritePremiumScaled,
    ).toBeNull();
    expect(
      priceClasses({ ...ENTRIES, input_uncached: null }, { cache_write_5m: 1 })
        .cacheWritePremiumScaled,
    ).toBeNull();
  });
});
