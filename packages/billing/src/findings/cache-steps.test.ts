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
  keepAliveCost,
  keepAlivePings,
  rewritePremium,
  SYSTEM_CONTEXT,
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
