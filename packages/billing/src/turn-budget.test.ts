/**
 * Unit tests for the per-turn budget (packages/billing/src/turn-budget.ts).
 *
 * Pure logic, with no DB and no I/O. Verifies the three enforcement modes and
 * the shared guard factory (including the "prompt"-mode approval that extends
 * the ceiling and the grace cushion that eventually hard-stops).
 */
import { describe, it, expect, vi } from "vitest";
import { providerCostUsd } from "./pricing";
import {
  TURN_BUDGET_MODE_VALUES,
  evaluateTurnBudget,
  createTurnBudgetGuard,
  turnCostUsd,
  type TurnBudgetPolicy,
} from "./turn-budget";

const policy = (over: Partial<TurnBudgetPolicy> = {}): TurnBudgetPolicy => ({
  enabled: true,
  limitUsd: 1,
  mode: "enforce",
  graceOveragePct: 0.25,
  ...over,
});

describe("mode values", () => {
  it("lists the three modes in strictness order", () => {
    expect(TURN_BUDGET_MODE_VALUES).toEqual(["grace", "prompt", "enforce"]);
  });
});

describe("evaluateTurnBudget", () => {
  it("is unbounded when disabled or limit <= 0", () => {
    expect(evaluateTurnBudget(policy({ enabled: false }), 999).action).toBe(
      "continue",
    );
    expect(evaluateTurnBudget(policy({ limitUsd: 0 }), 999).action).toBe(
      "continue",
    );
    expect(evaluateTurnBudget(policy({ enabled: false }), 999).ceilingUsd).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("enforce: continue under the limit, stop at/over it", () => {
    const p = policy({ mode: "enforce", limitUsd: 1 });
    expect(evaluateTurnBudget(p, 0.99)).toMatchObject({
      state: "ok",
      action: "continue",
    });
    expect(evaluateTurnBudget(p, 1)).toMatchObject({
      state: "exceeded",
      action: "stop",
    });
    expect(evaluateTurnBudget(p, 1.5)).toMatchObject({
      state: "exceeded",
      action: "stop",
    });
    expect(evaluateTurnBudget(p, 1).ceilingUsd).toBe(1);
  });

  it("prompt: continue under the limit, pause at/over it", () => {
    const p = policy({ mode: "prompt", limitUsd: 2 });
    expect(evaluateTurnBudget(p, 1.9)).toMatchObject({
      state: "ok",
      action: "continue",
    });
    expect(evaluateTurnBudget(p, 2)).toMatchObject({
      state: "at_limit",
      action: "pause",
    });
  });

  it("grace: continue within cushion, stop past the hard ceiling", () => {
    const p = policy({ mode: "grace", limitUsd: 1, graceOveragePct: 0.25 });
    expect(evaluateTurnBudget(p, 0.9)).toMatchObject({
      state: "ok",
      action: "continue",
    });
    // between limit (1.00) and ceiling (1.25) → keep going, flagged within_grace
    expect(evaluateTurnBudget(p, 1.1)).toMatchObject({
      state: "within_grace",
      action: "continue",
    });
    // at/over the 1.25 hard ceiling → stop
    expect(evaluateTurnBudget(p, 1.25)).toMatchObject({
      state: "exceeded",
      action: "stop",
    });
    expect(evaluateTurnBudget(p, 1.1).ceilingUsd).toBeCloseTo(1.25);
  });
});

describe("turnCostUsd", () => {
  it("prices cumulative usage via the rate card", () => {
    // 1M output tokens on a $75/1M output model = $75.
    const cost = turnCostUsd("claude-opus-4-1", { outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(75, 5);
  });

  // #1414: the guard and the charge path must price one turn the same way.
  // `chargeUsageCredits` prices through providerCostUsd with cacheWriteTokens;
  // turnCostUsd could not accept the field, so it handed the same tokens over
  // as fresh input and the guard believed the turn cost less than the customer
  // was charged. A ceiling was permeable by exactly that gap.
  const MODEL = "claude-opus-4-1";
  const charged = (usage: Parameters<typeof providerCostUsd>[0]) =>
    providerCostUsd(usage);

  it("agrees with the charge path on a turn WITH cache writes", () => {
    const guard = turnCostUsd(MODEL, {
      inputTokens: 1_000_000,
      outputTokens: 20_000,
      cacheWriteTokens: 900_000,
    });
    const invoice = charged({
      model: MODEL,
      inputTokens: 1_000_000,
      outputTokens: 20_000,
      cacheWriteTokens: 900_000,
    });
    expect(guard).toBeCloseTo(invoice, 9);
    // And the number is not the fresh-input one: 900k written tokens at Opus's
    // $18.75 write rate rather than its $15.00 input rate is $3.375 more than
    // the guard used to report.
    const asFreshInput = charged({
      model: MODEL,
      inputTokens: 1_000_000,
      outputTokens: 20_000,
    });
    expect(guard - asFreshInput).toBeCloseTo(3.375, 6);
  });

  it("agrees with the charge path on a turn with reads AND writes", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 50_000,
      cachedInputTokens: 600_000,
      cacheWriteTokens: 300_000,
    };
    expect(turnCostUsd(MODEL, usage)).toBeCloseTo(
      charged({
        model: MODEL,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      }),
      9,
    );
  });

  it("leaves a turn with NO cache traffic exactly where it was", () => {
    // The control. Without it, the two above would also pass if the whole
    // input side had drifted, and this term could not be told from that.
    const usage = { inputTokens: 1_000_000, outputTokens: 20_000 };
    const guard = turnCostUsd(MODEL, usage);
    expect(guard).toBeCloseTo(charged({ model: MODEL, ...usage }), 9);
    // 1M in at $15 + 20k out at $75/1M = $15 + $1.50.
    expect(guard).toBeCloseTo(16.5, 9);
  });
});

describe("createTurnBudgetGuard", () => {
  const million = { outputTokens: 1_000_000 }; // $75 on legacy Opus 4.1

  it("returns undefined when the budget is off", () => {
    expect(
      createTurnBudgetGuard(policy({ enabled: false }), "claude-opus-4-1"),
    ).toBeUndefined();
    expect(
      createTurnBudgetGuard(policy({ limitUsd: 0 }), "claude-opus-4-1"),
    ).toBeUndefined();
  });

  it("enforce: stops the turn and reports the reason once over budget", async () => {
    const onStop = vi.fn();
    const guard = createTurnBudgetGuard(
      policy({ mode: "enforce", limitUsd: 10 }),
      "claude-opus-4-1",
      { onStop },
    )!;
    expect(await guard({ outputTokens: 100_000 })).toBe("continue"); // $7.5 < $10
    expect(await guard(million)).toBe("stop"); // $75 > $10
    expect(onStop).toHaveBeenCalledOnce();
    expect(onStop.mock.calls[0]?.[0]).toMatchObject({
      mode: "enforce",
      action: "stop",
    });
  });

  it("prompt: approving extends the ceiling so the turn continues", async () => {
    const onPause = vi.fn().mockResolvedValue(true);
    const guard = createTurnBudgetGuard(
      policy({ mode: "prompt", limitUsd: 50 }),
      "claude-opus-4-1",
      { onPause },
    )!;
    // $75 > $50 → pause; approval grants another $50 window (ceiling → 75+50=125)
    expect(await guard(million)).toBe("continue");
    expect(onPause).toHaveBeenCalledOnce();
    // still under the extended $125 ceiling → no second pause
    expect(await guard(million)).toBe("continue");
    expect(onPause).toHaveBeenCalledOnce();
  });

  it("prompt: denying stops the turn", async () => {
    const onPause = vi.fn().mockResolvedValue(false);
    const onStop = vi.fn();
    const guard = createTurnBudgetGuard(
      policy({ mode: "prompt", limitUsd: 50 }),
      "claude-opus-4-1",
      { onPause, onStop },
    )!;
    expect(await guard(million)).toBe("stop");
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("onTick fires on every evaluation with cumulative cost and the live ceiling", async () => {
    const onTick = vi.fn();
    const onPause = vi.fn().mockResolvedValue(true);
    const guard = createTurnBudgetGuard(
      policy({ mode: "prompt", limitUsd: 50 }),
      "claude-opus-4-1",
      { onTick, onPause },
    )!;
    await guard({ outputTokens: 100_000 }); // $7.5, continue
    expect(onTick).toHaveBeenCalledWith(7.5, 50);
    await guard(million); // $75 → pause → approved, ceiling → 125
    expect(onTick).toHaveBeenCalledWith(75, 50);
    await guard(million); // ticks against the RAISED ceiling
    expect(onTick).toHaveBeenLastCalledWith(75, 125);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it("counts what the turn spent before the engine, read on each tick (#4228)", async () => {
    // The history summary costs $4 on its own model. Engine steps worth $7.50
    // fit a $10 budget alone, and the two together do not.
    let opening = 0;
    const onStop = vi.fn();
    const onTick = vi.fn();
    const guard = createTurnBudgetGuard(
      policy({ mode: "enforce", limitUsd: 10 }),
      "claude-opus-4-1",
      { onStop, onTick, openingCostUsd: () => opening },
    )!;
    // The summary has not finished when the guard is built.
    expect(await guard({ outputTokens: 100_000 })).toBe("continue");
    expect(onTick).toHaveBeenLastCalledWith(7.5, 10);
    opening = 4;
    expect(await guard({ outputTokens: 100_000 })).toBe("stop");
    expect(onTick).toHaveBeenLastCalledWith(11.5, 10);
    expect(onStop.mock.calls[0]?.[0]).toMatchObject({
      action: "stop",
      costUsd: 11.5,
      limitUsd: 10,
    });
  });

  it("stops on the opening cost alone before any engine usage (#4228)", async () => {
    const guard = createTurnBudgetGuard(
      policy({ mode: "enforce", limitUsd: 1 }),
      "claude-opus-4-1",
      { openingCostUsd: () => 1.25 },
    )!;
    expect(await guard({})).toBe("stop");
  });

  it("reads an opening cost that is not a finite positive number as nothing (negative)", async () => {
    for (const bad of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      const onTick = vi.fn();
      const guard = createTurnBudgetGuard(
        policy({ mode: "enforce", limitUsd: 10 }),
        "claude-opus-4-1",
        { onTick, openingCostUsd: () => bad },
      )!;
      expect(await guard({ outputTokens: 100_000 })).toBe("continue");
      expect(onTick).toHaveBeenLastCalledWith(7.5, 10);
    }
  });

  it("grace: flags the grace window, then hard-stops past the cushion", async () => {
    const onWithinGrace = vi.fn();
    const onStop = vi.fn();
    // limit $70, +25% cushion → hard ceiling $87.50
    const guard = createTurnBudgetGuard(
      policy({ mode: "grace", limitUsd: 70, graceOveragePct: 0.25 }),
      "claude-opus-4-1",
      { onWithinGrace, onStop },
    )!;
    expect(await guard(million)).toBe("continue"); // $75: over $70, within $87.50
    expect(onWithinGrace).toHaveBeenCalledOnce();
    expect(await guard({ outputTokens: 1_200_000 })).toBe("stop"); // $90 > $87.50
    expect(onStop).toHaveBeenCalledOnce();
  });
});
