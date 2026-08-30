/**
 * Unit tests for the per-turn budget (packages/billing/src/turn-budget.ts).
 *
 * Pure logic — no DB, no I/O. Verifies the three enforcement modes, mode
 * parsing, and the shared guard factory (including the "prompt"-mode approval
 * that extends the ceiling and the grace cushion that eventually hard-stops).
 */
import { describe, it, expect, vi } from "vitest";
import {
  TURN_BUDGET_MODES,
  TURN_BUDGET_MODE_VALUES,
  TURN_BUDGET_OFF,
  DEFAULT_GRACE_OVERAGE_PCT,
  parseTurnBudgetMode,
  evaluateTurnBudget,
  createTurnBudgetGuard,
  turnCostUsd,
  formatBudgetUsd,
  strictestMode,
  resolveEffectiveTurnBudget,
  type TurnBudgetPolicy,
  type GovernedBudget,
} from "./turn-budget";

const policy = (over: Partial<TurnBudgetPolicy> = {}): TurnBudgetPolicy => ({
  enabled: true,
  limitUsd: 1,
  mode: "enforce",
  graceOveragePct: DEFAULT_GRACE_OVERAGE_PCT,
  ...over,
});

describe("mode metadata", () => {
  it("has metadata for every mode value, in strictness order", () => {
    expect(TURN_BUDGET_MODE_VALUES).toEqual(["grace", "prompt", "enforce"]);
    for (const mode of TURN_BUDGET_MODE_VALUES) {
      expect(TURN_BUDGET_MODES[mode].mode).toBe(mode);
      expect(TURN_BUDGET_MODES[mode].label.length).toBeGreaterThan(0);
      expect(TURN_BUDGET_MODES[mode].description.length).toBeGreaterThan(0);
    }
  });

  it("TURN_BUDGET_OFF is disabled", () => {
    expect(TURN_BUDGET_OFF.enabled).toBe(false);
  });
});

describe("parseTurnBudgetMode", () => {
  it("resolves canonical values, aliases, and case-insensitively", () => {
    expect(parseTurnBudgetMode("grace")).toBe("grace");
    expect(parseTurnBudgetMode("HARD")).toBe("enforce");
    expect(parseTurnBudgetMode("ask")).toBe("prompt");
    expect(parseTurnBudgetMode("  approval ")).toBe("prompt");
    expect(parseTurnBudgetMode("soft")).toBe("grace");
    expect(parseTurnBudgetMode("stop")).toBe("enforce");
  });

  it("returns null for unknown / empty input", () => {
    expect(parseTurnBudgetMode("nonsense")).toBeNull();
    expect(parseTurnBudgetMode("")).toBeNull();
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
    const cost = turnCostUsd("claude-opus-4-8", { outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(75, 5);
  });
});

describe("createTurnBudgetGuard", () => {
  const million = { outputTokens: 1_000_000 }; // $75 on opus

  it("returns undefined when the budget is off", () => {
    expect(
      createTurnBudgetGuard(policy({ enabled: false }), "claude-opus-4-8"),
    ).toBeUndefined();
    expect(
      createTurnBudgetGuard(policy({ limitUsd: 0 }), "claude-opus-4-8"),
    ).toBeUndefined();
  });

  it("enforce: stops the turn and reports the reason once over budget", async () => {
    const onStop = vi.fn();
    const guard = createTurnBudgetGuard(
      policy({ mode: "enforce", limitUsd: 10 }),
      "claude-opus-4-8",
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
      "claude-opus-4-8",
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
      "claude-opus-4-8",
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
      "claude-opus-4-8",
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

  it("grace: flags the grace window, then hard-stops past the cushion", async () => {
    const onWithinGrace = vi.fn();
    const onStop = vi.fn();
    // limit $70, +25% cushion → hard ceiling $87.50
    const guard = createTurnBudgetGuard(
      policy({ mode: "grace", limitUsd: 70, graceOveragePct: 0.25 }),
      "claude-opus-4-8",
      { onWithinGrace, onStop },
    )!;
    expect(await guard(million)).toBe("continue"); // $75: over $70, within $87.50
    expect(onWithinGrace).toHaveBeenCalledOnce();
    expect(await guard({ outputTokens: 1_200_000 })).toBe("stop"); // $90 > $87.50
    expect(onStop).toHaveBeenCalledOnce();
  });
});

describe("formatBudgetUsd", () => {
  it("shows more precision for sub-cent amounts", () => {
    expect(formatBudgetUsd(1.2)).toBe("$1.20");
    expect(formatBudgetUsd(0.0034)).toBe("$0.0034");
    expect(formatBudgetUsd(0)).toBe("$0.00");
    expect(formatBudgetUsd(Number.POSITIVE_INFINITY)).toBe("∞");
  });
});

describe("strictestMode", () => {
  it("ranks enforce > prompt > grace", () => {
    expect(strictestMode("grace", "prompt")).toBe("prompt");
    expect(strictestMode("prompt", "enforce")).toBe("enforce");
    expect(strictestMode("grace", "enforce")).toBe("enforce");
    expect(strictestMode("grace", "grace")).toBe("grace");
  });
});

describe("resolveEffectiveTurnBudget", () => {
  const p = (over: Partial<TurnBudgetPolicy>): TurnBudgetPolicy => ({
    enabled: true,
    limitUsd: 1,
    mode: "enforce",
    graceOveragePct: DEFAULT_GRACE_OVERAGE_PCT,
    ...over,
  });
  const gov = (
    policy: TurnBudgetPolicy,
    enforcement: "default" | "ceiling",
  ): GovernedBudget => ({ policy, enforcement });

  // The six worked examples from the OXA-2081 spec — the governance guardrail.
  it("off user + workspace enforce-ceiling → forced $5 enforce", () => {
    const r = resolveEffectiveTurnBudget(
      TURN_BUDGET_OFF,
      null,
      gov(p({ limitUsd: 5, mode: "enforce" }), "ceiling"),
    );
    expect(r).toMatchObject({ enabled: true, limitUsd: 5, mode: "enforce" });
  });

  it("grace $20 user + $5 enforce-ceiling → clamped to $5 enforce", () => {
    const r = resolveEffectiveTurnBudget(
      p({ limitUsd: 20, mode: "grace" }),
      null,
      gov(p({ limitUsd: 5, mode: "enforce" }), "ceiling"),
    );
    expect(r).toMatchObject({ limitUsd: 5, mode: "enforce" });
  });

  it("off user + org default $10 prompt → adopts $10 prompt", () => {
    const r = resolveEffectiveTurnBudget(
      TURN_BUDGET_OFF,
      gov(p({ limitUsd: 10, mode: "prompt" }), "default"),
      null,
    );
    expect(r).toMatchObject({ enabled: true, limitUsd: 10, mode: "prompt" });
  });

  it("off user + org default $10 prompt + workspace default $3 grace → workspace wins ($3 grace)", () => {
    const r = resolveEffectiveTurnBudget(
      TURN_BUDGET_OFF,
      gov(p({ limitUsd: 10, mode: "prompt" }), "default"),
      gov(p({ limitUsd: 3, mode: "grace" }), "default"),
    );
    expect(r).toMatchObject({ limitUsd: 3, mode: "grace" });
  });

  it("prompt $2 user + $5 enforce-ceiling → keeps lower $2 limit but stricter enforce mode", () => {
    const r = resolveEffectiveTurnBudget(
      p({ limitUsd: 2, mode: "prompt" }),
      null,
      gov(p({ limitUsd: 5, mode: "enforce" }), "ceiling"),
    );
    expect(r).toMatchObject({ limitUsd: 2, mode: "enforce" });
  });

  it("enforce $8 user + org $5 enforce-ceiling + workspace default $20 grace → $5 enforce (user opted in, default ignored; ceiling clamps)", () => {
    const r = resolveEffectiveTurnBudget(
      p({ limitUsd: 8, mode: "enforce" }),
      gov(p({ limitUsd: 5, mode: "enforce" }), "ceiling"),
      gov(p({ limitUsd: 20, mode: "grace" }), "default"),
    );
    expect(r).toMatchObject({ limitUsd: 5, mode: "enforce" });
  });

  // Edge cases.
  it("a disabled or $0 ceiling never forces a turn-killing $0 budget", () => {
    expect(
      resolveEffectiveTurnBudget(
        TURN_BUDGET_OFF,
        null,
        gov(p({ enabled: false }), "ceiling"),
      ),
    ).toMatchObject({
      enabled: false,
    });
    expect(
      resolveEffectiveTurnBudget(
        TURN_BUDGET_OFF,
        null,
        gov(p({ limitUsd: 0 }), "ceiling"),
      ),
    ).toMatchObject({ enabled: false });
  });

  it("grace ceiling takes the tighter cushion", () => {
    const r = resolveEffectiveTurnBudget(
      p({ limitUsd: 10, mode: "grace", graceOveragePct: 0.5 }),
      null,
      gov(p({ limitUsd: 10, mode: "grace", graceOveragePct: 0.1 }), "ceiling"),
    );
    expect(r.mode).toBe("grace");
    expect(r.graceOveragePct).toBe(0.1);
  });

  it("no governance → returns the user policy unchanged", () => {
    const u = p({ limitUsd: 7, mode: "prompt" });
    expect(resolveEffectiveTurnBudget(u, null, null)).toMatchObject({
      limitUsd: 7,
      mode: "prompt",
    });
  });
});
