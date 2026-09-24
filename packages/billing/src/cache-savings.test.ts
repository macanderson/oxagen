// cache-savings.test.ts — the usage breakdown's cache saving, priced from the
// price book per price-boundary bucket (#4069).
import { describe, expect, it } from "vitest";
import { netCacheSavingsFromBook } from "./cache-savings";
import type { PriceEntry } from "./price-book";

const ORG = "00000000-0000-4000-8000-000000000001";
const RATE_CHANGE = new Date("2026-09-15T00:00:00.000Z");

function entry(
  overrides: Partial<PriceEntry> & Pick<PriceEntry, "id" | "tokenClass">,
): PriceEntry {
  return {
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "list",
    ...overrides,
  };
}

/** Input is $3 until the change and $4 after it; reads $0.30, writes $3.75 and $6. */
const BOOK: PriceEntry[] = [
  entry({
    id: "pe_in_old",
    tokenClass: "input_uncached",
    effectiveTo: RATE_CHANGE,
  }),
  entry({
    id: "pe_in_new",
    tokenClass: "input_uncached",
    microsPerMillion: 4_000_000n,
    effectiveFrom: RATE_CHANGE,
  }),
  entry({ id: "pe_cr", tokenClass: "cache_read", microsPerMillion: 300_000n }),
  entry({
    id: "pe_w5",
    tokenClass: "cache_write_5m",
    microsPerMillion: 3_750_000n,
  }),
  entry({
    id: "pe_w1",
    tokenClass: "cache_write_1h",
    microsPerMillion: 6_000_000n,
  }),
];

const BEFORE = "2026-09-14T10:00:00.000Z";
const AFTER = "2026-09-16T10:00:00.000Z";

describe("netCacheSavingsFromBook", () => {
  it("prices each bucket at the rates in force inside it", () => {
    const out = netCacheSavingsFromBook({
      book: BOOK,
      orgId: ORG,
      observed: [
        {
          model: "claude-sonnet-5",
          classes: [
            // 1000 × (3.00 − 0.30) and 1000 × (4.00 − 0.30), in micros.
            { tokenClass: "cache_read", tokens: 1000, firstSeen: BEFORE },
            { tokenClass: "cache_read", tokens: 1000, firstSeen: AFTER },
          ],
        },
      ],
    });
    expect(out).toEqual({ micros: 2700n + 3700n, unpricedBuckets: 0 });
  });

  it("nets out each write class's premium over fresh input", () => {
    const out = netCacheSavingsFromBook({
      book: BOOK,
      orgId: ORG,
      observed: [
        {
          model: "claude-sonnet-5",
          classes: [
            { tokenClass: "cache_read", tokens: 10_000, firstSeen: BEFORE },
            // 1000 × (3.75 − 3.00) = 750; 100 × (6.00 − 3.00) = 300.
            { tokenClass: "cache_write_5m", tokens: 1000, firstSeen: BEFORE },
            { tokenClass: "cache_write_1h", tokens: 100, firstSeen: BEFORE },
          ],
        },
      ],
    });
    expect(out.micros).toBe(27_000n - 750n - 300n);
  });

  it("can go negative when the write premium outweighs the reads", () => {
    const out = netCacheSavingsFromBook({
      book: BOOK,
      orgId: ORG,
      observed: [
        {
          model: "claude-sonnet-5",
          classes: [
            { tokenClass: "cache_write_5m", tokens: 1000, firstSeen: BEFORE },
          ],
        },
      ],
    });
    expect(out.micros).toBe(-750n);
  });

  it("ignores the classes a saving is not priced from", () => {
    const out = netCacheSavingsFromBook({
      book: BOOK,
      orgId: ORG,
      observed: [
        {
          model: "claude-sonnet-5",
          classes: [
            { tokenClass: "input_uncached", tokens: 1000, firstSeen: BEFORE },
            { tokenClass: "output", tokens: 1000, firstSeen: BEFORE },
            { tokenClass: "server_tool_request", tokens: 3, firstSeen: BEFORE },
          ],
        },
      ],
    });
    expect(out).toEqual({ micros: 0n, unpricedBuckets: 0 });
  });

  it("leaves out and counts a bucket the book cannot price, never guessing a rate", () => {
    const out = netCacheSavingsFromBook({
      book: BOOK,
      orgId: ORG,
      observed: [
        {
          model: "mystery-9",
          classes: [
            { tokenClass: "cache_read", tokens: 1000, firstSeen: BEFORE },
            { tokenClass: "cache_write_5m", tokens: 1000, firstSeen: BEFORE },
          ],
        },
        {
          model: "claude-sonnet-5",
          classes: [
            { tokenClass: "cache_read", tokens: 1000, firstSeen: BEFORE },
          ],
        },
      ],
    });
    expect(out).toEqual({ micros: 2700n, unpricedBuckets: 2 });
  });

  it("rounds once over the window, not once per bucket", () => {
    // Each bucket saves 2.7 micros; per-bucket rounding would answer 3 + 3.
    const out = netCacheSavingsFromBook({
      book: BOOK,
      orgId: ORG,
      observed: [
        {
          model: "claude-sonnet-5",
          classes: [
            { tokenClass: "cache_read", tokens: 1, firstSeen: BEFORE },
            {
              tokenClass: "cache_read",
              tokens: 1,
              firstSeen: new Date("2026-09-14T11:00:00.000Z"),
            },
          ],
        },
      ],
    });
    expect(out.micros).toBe(5n);
  });
});
