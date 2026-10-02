// cache-steps.test.ts — the walk detector 3 shares: the rewrite rule, the TTL
// in effect, the premium and keep-alive arithmetic, and the part that changed.
import { describe, expect, it } from "vitest";
import {
  AFTER_SYSTEM_CONTEXT,
  cacheSteps,
  changedPart,
  classPrice,
  formatMicros,
  gapMinutes,
  isBust,
  isIdleRewrite,
  isUnknownRewrite,
  keepAliveCost,
  keepAlivePings,
  rewritePremium,
  SYSTEM_CONTEXT,
  systemContextOf,
  type CacheStep,
} from "./cache-steps";
import {
  cacheFrame,
  cacheInput,
  cacheRun,
  listPrices,
  part,
} from "./cache-fixture";
import { detectInputFixture } from "./detect-input-fixture";
import type { FrameContextPart, PricedRequestFrame } from "./shared";

const A = part("system", "0", "s1");
const B = part("tool", "Bash", "b1");
const C = part("steering", "rec_1", "r1");

function frames(
  before: readonly FrameContextPart[] | null,
  after: readonly FrameContextPart[] | null,
): [PricedRequestFrame, PricedRequestFrame] {
  const run = cacheRun();
  return [
    cacheFrame(run, 0, {}, {
      systemContextDigest: "a",
      systemContextParts: before,
    }),
    cacheFrame(run, 1, {}, {
      systemContextDigest: "b",
      systemContextParts: after,
    }),
  ];
}

describe("changedPart", () => {
  it("is null when either request recorded no digest", () => {
    const [x, y] = frames([A], [A]);
    expect(changedPart({ ...x, systemContextDigest: null }, y)).toBeNull();
    expect(changedPart(x, { ...y, systemContextDigest: undefined })).toBeNull();
  });

  it("names the messages when the digests match", () => {
    const [x, y] = frames([A], [A]);
    expect(changedPart(x, { ...y, systemContextDigest: "a" })).toBe(
      AFTER_SYSTEM_CONTEXT,
    );
  });

  it("names the system context when a part list is missing", () => {
    expect(changedPart(...frames(null, [A]))).toBe(SYSTEM_CONTEXT);
    expect(changedPart(...frames([A], null))).toBe(SYSTEM_CONTEXT);
  });

  it("names a part that is new before one that moved", () => {
    expect(changedPart(...frames([A, B], [A, C, B]))).toBe(
      "steering record rec_1",
    );
  });

  it("names a part that is gone", () => {
    expect(changedPart(...frames([A, C, B], [A, B]))).toBe(
      "steering record rec_1",
    );
    expect(changedPart(...frames([A, B], [A]))).toBe("tool Bash");
  });

  it("names the part that moved into the first changed place", () => {
    expect(changedPart(...frames([A, B], [B, A]))).toBe("tool Bash");
  });

  it("names a part whose digest changed", () => {
    expect(
      changedPart(
        ...frames([A, part("context", "frame_1", "c1")], [
          A,
          part("context", "frame_1", "c2"),
        ]),
      ),
    ).toBe("context frame frame_1");
  });

  it("names the system context when the parts match but the digests differ", () => {
    expect(changedPart(...frames([A], [A]))).toBe(SYSTEM_CONTEXT);
  });
});

describe("the walk", () => {
  it("reads nothing when the pass read no frames", () => {
    const run = cacheRun();
    expect(
      cacheSteps(detectInputFixture({ runs: [run], frames: undefined })),
    ).toEqual([]);
  });

  it("walks an input once", () => {
    const run = cacheRun();
    const input = cacheInput([
      { run, frames: [cacheFrame(run, 0, { cache_write_5m: 10 })] },
    ]);
    expect(cacheSteps(input)).toBe(cacheSteps(input));
  });

  it("takes the TTL from the last write and prices both write classes", () => {
    const run = cacheRun();
    const input = cacheInput([
      {
        run,
        frames: [
          cacheFrame(run, 0, { input_uncached: 100, cache_write_1h: 40_000 }),
          // 70 minutes on, the 1-hour prefix is gone: a rewrite in both classes.
          cacheFrame(run, 4_200, {
            input_uncached: 100,
            cache_write_1h: 30_000,
            cache_write_5m: 20_000,
          }),
        ],
      },
    ]);
    const [first, step] = cacheSteps(input);
    expect(first).toMatchObject({ ttl: "5m", rewritten: 0, gapMicros: 0 });
    expect(step).toMatchObject({
      ttl: "1h",
      cached: 40_000,
      rewritten: 40_000,
      readBack: 0,
    });
    expect(isIdleRewrite(step!)).toBe(true);
    expect(isBust(step!)).toBe(false);
    // (30,000 × $5.70 + 20,000 × $3.45) × 40,000 ÷ 50,000 = $0.1920.
    expect(rewritePremium(step!)).toBe(192_000n);
    // One read at 54 minutes.
    expect(keepAlivePings(step!)).toBe(1);
    expect(keepAliveCost(step!)).toBe(12_000n);
  });

  it("leaves a request unpriced when a class it wrote has no price", () => {
    const run = cacheRun();
    const input = cacheInput([
      {
        run,
        frames: [
          cacheFrame(run, 0, { cache_write_5m: 40_000 }),
          cacheFrame(
            run,
            600,
            { cache_write_1h: 40_000 },
            { classPrices: { ...listPrices(), cache_write_1h: null } },
          ),
          cacheFrame(
            run,
            1_200,
            { cache_write_5m: 40_000 },
            { classPrices: { ...listPrices(), cache_write_5m: null } },
          ),
          cacheFrame(
            run,
            1_800,
            { cache_write_5m: 40_000 },
            { classPrices: { ...listPrices(), cache_read: null } },
          ),
        ],
      },
    ]);
    const [, oneHour, fiveMinute, noRead] = cacheSteps(input);
    expect(oneHour!.rewritten).toBe(40_000);
    expect(rewritePremium(oneHour!)).toBeNull();
    expect(rewritePremium(fiveMinute!)).toBeNull();
    expect(rewritePremium(noRead!)).toBeNull();
    expect(keepAliveCost(noRead!)).toBeNull();
    expect(classPrice(noRead!, "cache_write_5m")).toBe(3_750_000n);
  });

  it("gives no premium for a request that rewrote nothing", () => {
    const run = cacheRun();
    const [step] = cacheSteps(
      cacheInput([{ run, frames: [cacheFrame(run, 0, { cache_write_5m: 1 })] }]),
    );
    expect(rewritePremium(step!)).toBeNull();
  });

  it("walks two providers that serve one model on one chain apart (#4614)", () => {
    const run = cacheRun();
    const input = cacheInput([
      {
        run,
        frames: [
          cacheFrame(
            run,
            0,
            { input_uncached: 100, cache_write_5m: 40_000 },
            { provider: "anthropic" },
          ),
          // Two minutes on, the other provider writes its own cache.
          cacheFrame(
            run,
            120,
            { input_uncached: 100, cache_write_5m: 40_000 },
            { provider: "bedrock" },
          ),
        ],
      },
    ]);
    const steps = cacheSteps(input);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.prev).toBeNull();
      expect(step.rewritten).toBe(0);
      expect(isBust(step)).toBe(false);
    }
  });
});

describe("the cause of a rewrite (#4614)", () => {
  /**
   * A 40,000-token prefix written, then written again `gapSeconds` later,
   * with the system context digests given on the two requests.
   */
  function rewrite(
    gapSeconds: number,
    before: string | null,
    after: string | null,
  ): CacheStep {
    const run = cacheRun();
    const steps = cacheSteps(
      cacheInput([
        {
          run,
          frames: [
            cacheFrame(
              run,
              0,
              { input_uncached: 100, cache_write_5m: 40_000 },
              { systemContextDigest: before },
            ),
            cacheFrame(
              run,
              gapSeconds,
              { input_uncached: 100, cache_write_5m: 40_000 },
              { systemContextDigest: after },
            ),
          ],
        },
      ]),
    );
    const step = steps[1]!;
    expect(step.rewritten).toBe(40_000);
    return step;
  }

  it("reads a rewrite past the TTL with a digest missing as neither idle nor a bust", () => {
    for (const [before, after] of [
      [null, null],
      [null, "a"],
      ["a", null],
    ] as const) {
      const step = rewrite(600, before, after);
      expect(systemContextOf(step)).toBe("unknown");
      expect(isIdleRewrite(step)).toBe(false);
      expect(isBust(step)).toBe(false);
      expect(isUnknownRewrite(step)).toBe(true);
    }
  });

  it("reads a digest the frame left undefined as missing", () => {
    const step = rewrite(600, "a", "a");
    const missing = {
      ...step,
      prev: { ...step.prev!, systemContextDigest: undefined },
    };
    expect(isIdleRewrite(missing)).toBe(false);
    expect(isUnknownRewrite(missing)).toBe(true);
  });

  it("reads a rewrite past the TTL as idle when the digests match, and as a bust when they differ", () => {
    const same = rewrite(600, "a", "a");
    expect(isIdleRewrite(same)).toBe(true);
    expect(isBust(same)).toBe(false);
    expect(isUnknownRewrite(same)).toBe(false);
    const changed = rewrite(600, "a", "b");
    expect(isIdleRewrite(changed)).toBe(false);
    expect(isBust(changed)).toBe(true);
    expect(isUnknownRewrite(changed)).toBe(false);
  });

  it("keeps a rewrite within the TTL a bust whatever the digests, since the prefix was still cached", () => {
    for (const [before, after] of [
      [null, null],
      ["a", "a"],
      ["a", "b"],
    ] as const) {
      const step = rewrite(120, before, after);
      expect(isBust(step)).toBe(true);
      expect(isIdleRewrite(step)).toBe(false);
      expect(isUnknownRewrite(step)).toBe(false);
    }
  });
});

describe("formatting", () => {
  it("prints micros as money to the cent", () => {
    expect(formatMicros(144_900n, "usd")).toBe("$0.14");
    expect(formatMicros(1_234_567_890n, "EUR")).toBe("€1,234.57");
  });

  it("falls back to the code when the currency is not one Intl knows", () => {
    expect(formatMicros(144_900n, "not-a-code")).toBe("0.14 NOT-A-CODE");
  });

  it("rounds a gap to whole minutes", () => {
    expect(gapMinutes(629_000_000)).toBe(10);
    expect(gapMinutes(631_000_000)).toBe(11);
  });
});
