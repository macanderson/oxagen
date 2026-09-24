// Model fit (pages/run.md, Model fit): whether the class the run ran on was
// the right size, read from prompts, failed tool calls, turns and steps. The
// rig strip and the Cost tab's panel both read `runFit`, so these tests hold
// the reading itself: where it refuses to read, where it claims a rung, and
// where it stops at the end of a ladder.
import { describe, expect, it } from "vitest";
import type { RunRow } from "@/data/contracts/runs";
import { runFit } from "./fit";
import type { RunMetrics } from "./metrics";
import { runRow } from "./run.builders";

/**
 * Metrics that carry only what the reading is keyed on: one prompt, a whole
 * transcript and no tool calls. Every other figure is absent, so a test sets
 * the one field its branch reads.
 */
function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    whole: true,
    tokens: null,
    priced: null,
    cost: null,
    costIsEstimate: false,
    cacheHit: null,
    productiveRatio: null,
    prompts: { count: 1, corrective: 0 },
    wall: {
      ms: null,
      sealed: false,
      closedIdle: false,
      ticking: null,
      parts: null,
      lead: null,
    },
    modelCalls: null,
    toolCalls: [],
    families: null,
    batches: null,
    errors: null,
    perModelCall: null,
    reportedTokens: null,
    ...overrides,
  };
}

/** One tool call; `failed` is the only field the reading reads. */
function call(failed: boolean): NonNullable<RunMetrics["toolCalls"]>[number] {
  return { name: "Bash", group: "shell", ms: 10, failed, seq: "5", batch: 0 };
}

/** A sealed run on the middle class of the Anthropic ladder, too long to be small. */
function run(overrides: Partial<RunRow> = {}): RunRow {
  return runRow({
    turns: 8,
    steps: 40,
    model: { slug: "claude-sonnet-5", provider: "anthropic", tier: "sonnet" },
    enforcementTier: "harness",
    ...overrides,
  });
}

describe("runFit", () => {
  it("reads a long first-try run on the middle class as a fit, and names what it read", () => {
    const fit = runFit(run(), metrics({ toolCalls: [call(false)] }));
    expect(fit.read).toEqual({ prompts: 1, turns: 8, steps: 40, failed: 0 });
    expect(fit.model).toEqual({ verdict: "fit", tier: "sonnet" });
  });

  it("argues one rung down for a small first-try run", () => {
    const fit = runFit(run({ turns: 2 }), metrics());
    expect(fit.model).toEqual({
      verdict: "over",
      tier: "sonnet",
      suggest: "haiku",
    });
  });

  it("counts a run as small on its turns or its steps alone, at the bound itself", () => {
    // Three turns is small however many steps; twelve steps is small however many turns.
    expect(runFit(run({ turns: 3, steps: 90 }), metrics()).model).toMatchObject(
      { verdict: "over" },
    );
    expect(
      runFit(run({ turns: 30, steps: 12 }), metrics()).model,
    ).toMatchObject({ verdict: "over" });
    // One past both bounds is not small.
    expect(runFit(run({ turns: 4, steps: 13 }), metrics()).model).toEqual({
      verdict: "fit",
      tier: "sonnet",
    });
  });

  it("argues one rung up when the operator prompted again, and when a tool call failed", () => {
    const reprompted = runFit(
      run(),
      metrics({ prompts: { count: 3, corrective: 2 } }),
    );
    expect(reprompted.model).toEqual({
      verdict: "under",
      tier: "sonnet",
      suggest: "opus",
    });
    const failed = runFit(
      run(),
      metrics({ toolCalls: [call(false), call(true), call(true)] }),
    );
    expect(failed.read?.failed).toBe(2);
    expect(failed.model).toMatchObject({ verdict: "under", suggest: "opus" });
  });

  it("reads a redone run as under even when it was small: a retry outweighs a short run", () => {
    const fit = runFit(
      run({ turns: 2, steps: 5 }),
      metrics({ toolCalls: [call(true)] }),
    );
    expect(fit.model).toMatchObject({ verdict: "under", suggest: "opus" });
  });

  it("claims no rung below the smallest class or above the largest, and calls the run a fit (negative)", () => {
    const smallest = runFit(
      run({
        turns: 1,
        model: { slug: "claude-haiku-5", provider: "anthropic", tier: "haiku" },
      }),
      metrics(),
    );
    expect(smallest.model).toEqual({ verdict: "fit", tier: "haiku" });
    const largest = runFit(
      run({
        model: { slug: "claude-opus-5", provider: "anthropic", tier: "opus" },
      }),
      metrics({ prompts: { count: 2, corrective: 1 } }),
    );
    expect(largest.model).toEqual({ verdict: "fit", tier: "opus" });
  });

  it.each<[string, string, string]>([
    ["mini", "over", "nano"],
    ["flash", "over", "flash-lite"],
    ["flash-lite", "under", "flash"],
  ])(
    "climbs the %s class's own family ladder, never another vendor's",
    (tier, verdict, suggest) => {
      const redone = verdict === "under";
      const fit = runFit(
        run({
          turns: redone ? 8 : 1,
          model: { slug: `model-${tier}`, provider: "vendor", tier },
        }),
        metrics({
          prompts: { count: redone ? 2 : 1, corrective: redone ? 1 : 0 },
        }),
      );
      expect(fit.model).toEqual({ verdict, tier, suggest });
    },
  );

  it("names what it read but claims no rung for a class on no ladder, or no class at all (negative)", () => {
    const unknown = runFit(
      run({ model: { slug: "x-1", provider: "x", tier: "ultra" } }),
      metrics(),
    );
    expect(unknown.read).not.toBeNull();
    expect(unknown.model).toBeNull();
    const untiered = runFit(
      run({ model: { slug: "x-1", provider: "x", tier: null } }),
      metrics(),
    );
    expect(untiered.read).not.toBeNull();
    expect(untiered.model).toBeNull();
    const unmodelled = runFit(run({ model: null }), metrics());
    expect(unmodelled.read).not.toBeNull();
    expect(unmodelled.model).toBeNull();
  });

  it("reads nothing when the record lacks the prompts, the turns or the tool calls (negative)", () => {
    for (const fit of [
      runFit(run(), metrics({ prompts: null })),
      runFit(run({ turns: null }), metrics()),
      runFit(run(), metrics({ toolCalls: null })),
    ]) {
      expect(fit.read).toBeNull();
      expect(fit.model).toBeNull();
    }
  });

  it("reads nothing for a sealed run whose transcript stops short, since its counts are floors (negative)", () => {
    const fit = runFit(run(), metrics({ whole: false }));
    expect(fit.read).toBeNull();
    expect(fit.model).toBeNull();
  });

  it("still reads a live run whose transcript is not whole, since that is everything recorded so far", () => {
    const fit = runFit(
      run({ status: "live", sealedAt: null }),
      metrics({ whole: false }),
    );
    expect(fit.read).toEqual({ prompts: 1, turns: 8, steps: 40, failed: 0 });
    expect(fit.model).toEqual({ verdict: "fit", tier: "sonnet" });
  });

  it.each<[RunRow["enforcementTier"], "not_sent" | "not_proxied"]>([
    ["gateway", "not_sent"],
    ["contained", "not_sent"],
    ["harness", "not_proxied"],
    ["observe", "not_proxied"],
  ])(
    "never reads the effort at the %s tier, and says it was %s",
    (enforcementTier, why) => {
      const fit = runFit(run({ enforcementTier }), metrics());
      expect(fit.effort).toEqual({ verdict: "unseen", why });
    },
  );

  it("names the effort's reason even when it reads nothing else (negative)", () => {
    const fit = runFit(
      run({ enforcementTier: "gateway" }),
      metrics({ prompts: null }),
    );
    expect(fit.effort).toEqual({ verdict: "unseen", why: "not_sent" });
  });
});
