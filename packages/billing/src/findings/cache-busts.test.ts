// cache-busts.test.ts — cache busts (detector 3): the rewrite whose prefix
// changed, priced against reading it back, with the part that changed.
import { describe, expect, it } from "vitest";
import type { RunTotalsRecord } from "../cost-rollup";
import { cacheBusts } from "./cache-busts";
import {
  CACHE_AGENT,
  cacheFrame,
  cacheInput,
  cacheRun,
  part,
} from "./cache-fixture";
import { detectFindings } from "./index";
import {
  Groups,
  type DetectContext,
  type DetectInput,
  type FindingDraft,
  type FrameContextPart,
  type PricedRequestFrame,
} from "./shared";

const SYSTEM = part("system", "0", "s1");
const BASH = part("tool", "Bash", "b1");

/**
 * A prefix written, read back once, then written again `gapSeconds` later.
 * The rewrite is 42,000 tokens at $3.45 over the read, $0.1449. The two
 * frames around the rewrite carry the system contexts given.
 */
function bustWalk(
  run: RunTotalsRecord,
  gapSeconds: number,
  before: { digest: string | null; parts?: FrameContextPart[] | null },
  after: { digest: string | null; parts?: FrameContextPart[] | null },
): PricedRequestFrame[] {
  return [
    cacheFrame(run, 0, { input_uncached: 100, cache_write_5m: 40_000 }),
    cacheFrame(
      run,
      60,
      { input_uncached: 100, cache_read: 40_000, cache_write_5m: 2_000 },
      {
        systemContextDigest: before.digest,
        systemContextParts: before.parts ?? null,
      },
    ),
    cacheFrame(
      run,
      60 + gapSeconds,
      { input_uncached: 100, cache_write_5m: 42_500 },
      {
        systemContextDigest: after.digest,
        systemContextParts: after.parts ?? null,
      },
    ),
  ];
}

function bust(drafts: FindingDraft[]): FindingDraft | undefined {
  return drafts.find((d) => d.kind === "cache_busts");
}

function context(input: DetectInput): DetectContext {
  return {
    groups: new Groups(input.decidedSince),
    runs: new Map(input.runs.map((r) => [r.runId, r])),
    views: [],
    claimed: new Set(),
    taken: new Set(),
  };
}

describe("cache busts", () => {
  it("prices a rewrite within the TTL against reading the prefix back", () => {
    const run = cacheRun();
    const finding = bust(
      detectFindings(
        cacheInput([
          {
            run,
            frames: bustWalk(
              run,
              120,
              { digest: "a", parts: [SYSTEM, BASH] },
              { digest: "b", parts: [SYSTEM, { ...BASH, digest: "b2" }] },
            ),
          },
        ]),
      ),
    );
    expect(finding).toBeDefined();
    expect(finding!.subject).toBe(CACHE_AGENT);
    expect(finding!.evidence).toMatchObject({
      calls: 1,
      coveredCalls: 1,
      measuredTokens: 42_000,
      counterfactualTokens: 0,
      measuredMicros: "144900",
      counterfactualMicros: "0",
    });
    expect(finding!.savingMicros).toBe(144_900n);
    expect(finding!.recommendation).toBeUndefined();
    expect(finding!.why).toBe(
      `${CACHE_AGENT} rewrote its cache 1 time because the start of the prompt changed. The first change was in tool Bash (1 time). The rewrites cost $0.14 more than reading the cache back.`,
    );
    expect(finding!.fix).toBe(
      `Keep the start of the prompt for ${CACHE_AGENT} the same from one request to the next. Move what changes, such as tool Bash, below the cached prefix, or change it between runs.`,
    );
  });

  it("counts a changed system context after a long wait as a bust, since no keep-alive would have held it", () => {
    const run = cacheRun();
    const drafts = detectFindings(
      cacheInput([
        {
          run,
          frames: bustWalk(
            run,
            600,
            { digest: "a", parts: [SYSTEM] },
            { digest: "b", parts: [SYSTEM, BASH] },
          ),
        },
      ]),
    );
    expect(drafts.find((d) => d.kind === "idle_cache_rewrites")).toBeUndefined();
    expect(bust(drafts)!.why).toMatch(/first change was in tool Bash/);
  });

  it("says when no request recorded a digest", () => {
    const run = cacheRun();
    const finding = bust(
      detectFindings(
        cacheInput([
          {
            run,
            frames: bustWalk(run, 120, { digest: null }, { digest: null }),
          },
        ]),
      ),
    );
    expect(finding!.why).toMatch(
      /No request recorded a system context digest, so the part that changed is unknown\./,
    );
    expect(finding!.fix).toMatch(/Move what changes below the cached prefix/);
  });

  it("names the messages when the system context stayed the same", () => {
    const run = cacheRun();
    const finding = bust(
      detectFindings(
        cacheInput([
          {
            run,
            frames: bustWalk(run, 120, { digest: "a" }, { digest: "a" }),
          },
        ]),
      ),
    );
    expect(finding!.why).toMatch(
      /The first change was in the messages after the system context \(1 time\)\./,
    );
  });

  it("ranks the parts that changed, and counts the busts with no digest", () => {
    const runs = [cacheRun(), cacheRun(), cacheRun(), cacheRun(), cacheRun()];
    const tools = ["Bash", "Bash", "Read", "Grep"];
    const walks = runs.map((run, i) =>
      i < tools.length
        ? bustWalk(
            run,
            120,
            { digest: "a", parts: [SYSTEM] },
            { digest: "b", parts: [SYSTEM, part("tool", tools[i]!, "t")] },
          )
        : bustWalk(run, 120, { digest: null }, { digest: null }),
    );
    // One more part, on its own run, pushes a fourth label past the three named.
    const extra = cacheRun();
    const finding = bust(
      detectFindings(
        cacheInput([
          ...runs.map((run, i) => ({ run, frames: walks[i]! })),
          {
            run: extra,
            frames: bustWalk(
              extra,
              120,
              { digest: "a", parts: [SYSTEM] },
              { digest: "c", parts: [part("system", "0", "s2")] },
            ),
          },
        ]),
      ),
    );
    expect(finding!.evidence.calls).toBe(6);
    expect(finding!.why).toContain(
      "The first change was in tool Bash (2 times), system block 0 (1 time), tool Grep (1 time), and 1 other part. 1 bust recorded no system context digest.",
    );
  });

  it("cites an unpriced bust uncovered", () => {
    const run = cacheRun();
    const frames = bustWalk(run, 120, { digest: null }, { digest: null }).map(
      (f) => ({ ...f, classPrices: undefined }),
    );
    const input = cacheInput([{ run, frames }]);
    const ctx = context(input);
    cacheBusts.detect(input, ctx);
    const [group] = [...ctx.groups.values()];
    expect(group).toMatchObject({ kind: "cache_busts", calls: 1, covered: 0 });
    expect(ctx.claimed.size).toBe(0);
    expect(cacheBusts.counting).toBeNull();
    expect(bust(detectFindings(input))).toBeUndefined();
  });

  it("says its cost covers only the busts with a price (#4614)", () => {
    const priced = cacheRun();
    const unpriced = cacheRun();
    const finding = bust(
      detectFindings(
        cacheInput([
          {
            run: priced,
            frames: bustWalk(priced, 120, { digest: "a" }, { digest: "a" }),
          },
          {
            run: unpriced,
            frames: bustWalk(
              unpriced,
              120,
              { digest: "a" },
              { digest: "a" },
            ).map((f) => ({ ...f, classPrices: undefined })),
          },
        ]),
      ),
    );
    expect(finding!.evidence).toMatchObject({
      calls: 2,
      coveredCalls: 1,
      measuredMicros: "144900",
    });
    expect(finding!.why).toBe(
      `${CACHE_AGENT} rewrote its cache 2 times because the start of the prompt changed. The first change was in the messages after the system context (2 times). The 1 of 2 rewrites with a price cost $0.14 more than reading the cache back.`,
    );
  });

  it("counts no bust for a rewrite past the TTL with a digest missing, and no idle rewrite either (#4614)", () => {
    const run = cacheRun();
    const drafts = detectFindings(
      cacheInput([
        {
          run,
          frames: bustWalk(run, 600, { digest: null }, { digest: "a" }),
        },
      ]),
    );
    expect(drafts).toEqual([]);
  });

  it("leaves out a request that read its prefix back", () => {
    const run = cacheRun();
    const frames = [
      cacheFrame(run, 0, { input_uncached: 100, cache_write_5m: 40_000 }),
      // A large write that reads every cached token is new context.
      cacheFrame(run, 60, {
        input_uncached: 100,
        cache_read: 40_000,
        cache_write_5m: 60_000,
      }),
    ];
    expect(detectFindings(cacheInput([{ run, frames }]))).toEqual([]);
  });

  it("claims no frame", () => {
    const run = cacheRun();
    const drafts = detectFindings(
      cacheInput([
        {
          run,
          frames: bustWalk(run, 120, { digest: "a" }, { digest: "a" }),
        },
      ]),
    );
    expect(bust(drafts)!.claims).toBeUndefined();
  });

  it("prints the prose from the evidence alone when the pass kept no stats", () => {
    const run = cacheRun();
    const input = cacheInput([
      {
        run,
        frames: bustWalk(run, 120, { digest: "a" }, { digest: "a" }),
      },
    ]);
    const ctx = context(input);
    cacheBusts.detect(input, ctx);
    const [group] = [...ctx.groups.values()];
    const stranger = { ...group! };
    const prose = cacheBusts.prose(stranger, {
      calls: 1,
      coveredCalls: 1,
      measuredTokens: 1,
      counterfactualTokens: 0,
      measuredMicros: "10000",
      counterfactualMicros: "0",
      operatorKeys: [],
      runs: [],
    });
    expect(prose.why).toMatch(/part that changed is unknown/);
  });
});
