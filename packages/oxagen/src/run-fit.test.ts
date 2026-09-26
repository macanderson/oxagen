// The Model fit reading (#3893): whether the model class and the effort
// setting were the right size for one sealed run. These tests hold the rule
// itself: where it refuses to read, where it claims a rung, and where it stops
// at the end of a ladder. Every answer parses against the stored shape.
import { describe, expect, it } from "vitest";
import {
  runFit,
  type RunFitInput,
  type RunFitRead,
  runFitReadingSchema,
} from "./run-fit";

/** A long first-try run with no reasoning recorded. */
function read(over: Partial<RunFitRead> = {}): RunFitRead {
  return {
    prompts: 1,
    turns: 8,
    steps: 40,
    failed: 0,
    outputTokens: 10_000,
    reasoningTokens: 0,
    ...over,
  };
}

/** A harness-tier run on the middle Anthropic class, with no effort recorded. */
function input(over: Partial<RunFitInput> = {}): RunFitInput {
  return {
    tier: "sonnet",
    effort: null,
    effortSource: null,
    proxied: false,
    read: read(),
    ...over,
  };
}

/** The reading, parsed against the stored shape so no branch writes a body the column refuses. */
function fit(over: Partial<RunFitInput> = {}) {
  const reading = runFit(input(over));
  expect(runFitReadingSchema.parse(reading)).toEqual(reading);
  return reading;
}

describe("the model class", () => {
  it("reads a long first-try run on the middle class as a fit, and names what it read", () => {
    const reading = fit();
    expect(reading.read).toEqual(read());
    expect(reading.model).toEqual({ verdict: "fit", tier: "sonnet" });
  });

  it("argues one rung down for a small first-try run (model over)", () => {
    expect(fit({ read: read({ turns: 2 }) }).model).toEqual({
      verdict: "over",
      tier: "sonnet",
      suggest: "haiku",
    });
  });

  it("counts a run as small on its turns or its steps alone, at the bound itself", () => {
    expect(fit({ read: read({ turns: 3, steps: 90 }) }).model).toMatchObject({
      verdict: "over",
    });
    expect(fit({ read: read({ turns: 30, steps: 12 }) }).model).toMatchObject({
      verdict: "over",
    });
    expect(fit({ read: read({ turns: 4, steps: 13 }) }).model).toEqual({
      verdict: "fit",
      tier: "sonnet",
    });
  });

  it("argues one rung up when the operator prompted again, and when a tool call failed (model under)", () => {
    expect(fit({ read: read({ prompts: 3 }) }).model).toEqual({
      verdict: "under",
      tier: "sonnet",
      suggest: "opus",
    });
    expect(fit({ read: read({ failed: 2 }) }).model).toMatchObject({
      verdict: "under",
      suggest: "opus",
    });
  });

  it("reads a redone run as under even when it was small: a retry outweighs a short run", () => {
    expect(
      fit({ read: read({ turns: 2, steps: 5, failed: 1 }) }).model,
    ).toMatchObject({ verdict: "under", suggest: "opus" });
  });

  it("claims no rung below the smallest class or above the largest (negative)", () => {
    expect(fit({ tier: "haiku", read: read({ turns: 1 }) }).model).toEqual({
      verdict: "fit",
      tier: "haiku",
    });
    expect(fit({ tier: "opus", read: read({ prompts: 2 }) }).model).toEqual({
      verdict: "fit",
      tier: "opus",
    });
  });

  it.each<[string, "over" | "under", string]>([
    ["mini", "over", "nano"],
    ["flash", "over", "flash-lite"],
    ["flash-lite", "under", "flash"],
  ])(
    "climbs the %s class's own family ladder, never another vendor's",
    (tier, verdict, suggest) => {
      const under = verdict === "under";
      expect(
        fit({
          tier,
          read: read({ turns: under ? 8 : 1, prompts: under ? 2 : 1 }),
        }).model,
      ).toEqual({ verdict, tier, suggest });
    },
  );

  it("names what it read but claims no rung for a class on no ladder, or no class at all (negative)", () => {
    for (const tier of ["ultra", "fable", null]) {
      const reading = fit({ tier });
      expect(reading.read).not.toBeNull();
      expect(reading.model).toBeNull();
    }
  });

  it("reads nothing, and claims no class, when the record lacks a figure (negative)", () => {
    const reading = fit({ read: null });
    expect(reading.read).toBeNull();
    expect(reading.model).toBeNull();
  });
});

describe("the effort setting", () => {
  it("argues one rung down when a first-try run spent more than a fifth of its output reasoning (effort over)", () => {
    expect(
      fit({
        effort: "high",
        effortSource: "request",
        proxied: true,
        read: read({ outputTokens: 1_000, reasoningTokens: 201 }),
      }).effort,
    ).toEqual({
      verdict: "over",
      effort: "high",
      source: "request",
      suggest: "medium",
    });
  });

  it("stops at the reasoning bound, and needs both token figures to argue for less (negative)", () => {
    const high = { effort: "high", effortSource: "harness" as const };
    expect(
      fit({ ...high, read: read({ outputTokens: 1_000, reasoningTokens: 200 }) })
        .effort,
    ).toEqual({ verdict: "fit", effort: "high", source: "harness" });
    expect(
      fit({ ...high, read: read({ reasoningTokens: null }) }).effort,
    ).toMatchObject({ verdict: "fit" });
    expect(
      fit({ ...high, read: read({ outputTokens: null, reasoningTokens: 9 }) })
        .effort,
    ).toMatchObject({ verdict: "fit" });
    expect(
      fit({ ...high, read: read({ outputTokens: 0, reasoningTokens: 0 }) })
        .effort,
    ).toMatchObject({ verdict: "fit" });
  });

  it("argues one rung up when the run was redone (effort under)", () => {
    expect(
      fit({
        effort: "low",
        effortSource: "harness",
        read: read({ prompts: 2 }),
      }).effort,
    ).toEqual({
      verdict: "under",
      effort: "low",
      source: "harness",
      suggest: "medium",
    });
    expect(
      fit({ effort: "medium", effortSource: "request", read: read({ failed: 1 }) })
        .effort,
    ).toMatchObject({ verdict: "under", suggest: "high" });
  });

  it("claims no rung below low or above high, and none for an effort off the ladder (negative)", () => {
    expect(
      fit({
        effort: "low",
        effortSource: "request",
        read: read({ outputTokens: 100, reasoningTokens: 90 }),
      }).effort,
    ).toEqual({ verdict: "fit", effort: "low", source: "request" });
    expect(
      fit({ effort: "high", effortSource: "request", read: read({ prompts: 2 }) })
        .effort,
    ).toEqual({ verdict: "fit", effort: "high", source: "request" });
    for (const effort of ["max", "xhigh", "minimal"])
      expect(
        fit({ effort, effortSource: "request", read: read({ prompts: 3 }) })
          .effort,
      ).toEqual({ verdict: "fit", effort, source: "request" });
  });

  it("reads fit on both when a long first-try run spent little reasoning (fit on both)", () => {
    const reading = fit({
      effort: "medium",
      effortSource: "harness",
      read: read({ outputTokens: 1_000, reasoningTokens: 50 }),
    });
    expect(reading.model).toEqual({ verdict: "fit", tier: "sonnet" });
    expect(reading.effort).toEqual({
      verdict: "fit",
      effort: "medium",
      source: "harness",
    });
  });

  it("says the effort was not captured where Oxagen never read the request (not_proxied)", () => {
    expect(fit({ proxied: false }).effort).toEqual({
      verdict: "unseen",
      why: "not_proxied",
    });
  });

  it("says the agent sent none where Oxagen proxied the calls and the request carried none (not_sent)", () => {
    expect(fit({ proxied: true }).effort).toEqual({
      verdict: "unseen",
      why: "not_sent",
    });
    // A blank value is none, not an effort called "".
    expect(fit({ proxied: true, effort: "  " }).effort).toEqual({
      verdict: "unseen",
      why: "not_sent",
    });
  });

  it("names the effort's reason, or the effort itself, even when it reads nothing else", () => {
    expect(fit({ proxied: true, read: null }).effort).toEqual({
      verdict: "unseen",
      why: "not_sent",
    });
    expect(
      fit({ effort: "high", effortSource: "request", read: null }).effort,
    ).toEqual({ verdict: "fit", effort: "high", source: "request" });
  });

  it("reads a harness-reported effort with no source as the harness's, and clamps a long one", () => {
    expect(
      fit({ effort: "x".repeat(40), effortSource: null }).effort,
    ).toEqual({ verdict: "fit", effort: "x".repeat(32), source: "harness" });
  });
});
