/**
 * model-state.test.ts
 *
 * Tests for the pure helpers exported from model-state.ts:
 *   - defaultModelState: correct shape and defaults
 *   - buildSeededModelState: correct derivation from ModelStateSeed
 */

import { describe, it, expect } from "vitest";
import {
  defaultModelState,
  buildSeededModelState,
  applyWorkspaceBudgetGovernance,
  type WorkspaceBudgetGovernance,
} from "./model-state";

describe("defaultModelState", () => {
  it("has tier = 'fast'", () => {
    expect(defaultModelState.tier).toBe("fast");
  });

  it("has model = null", () => {
    expect(defaultModelState.model).toBeNull();
  });

  it("has effort = 'medium'", () => {
    expect(defaultModelState.effort).toBe("medium");
  });

  // ADR-041 removed image and video generation, so the composer state carries
  // no generate mode, media tier or media model at all.
  it("carries no media-generation fields (ADR-041)", () => {
    expect(defaultModelState).not.toHaveProperty("generate");
    expect(defaultModelState).not.toHaveProperty("mediaTier");
    expect(defaultModelState).not.toHaveProperty("mediaModel");
    expect(defaultModelState).not.toHaveProperty("seededImageModel");
    expect(defaultModelState).not.toHaveProperty("seededVideoModel");
  });

  it("has the per-turn budget off by default", () => {
    expect(defaultModelState.budgetEnabled).toBe(false);
    expect(defaultModelState.budgetUsd).toBeNull();
    expect(defaultModelState.budgetMode).toBe("prompt");
    expect(defaultModelState.budgetGracePct).toBe(0.25);
  });
});

describe("buildSeededModelState", () => {
  it("uses textModel when provided — clears tier", () => {
    const state = buildSeededModelState({
      textModel: "claude-sonnet-5",
      textTier: null,
    });
    expect(state.model).toBe("claude-sonnet-5");
    expect(state.tier).toBeNull();
  });

  it("falls back to textTier when textModel is null", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: "balanced",
    });
    expect(state.model).toBeNull();
    expect(state.tier).toBe("balanced");
  });

  it("defaults tier to 'fast' when both textModel and textTier are null", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
    });
    expect(state.tier).toBe("fast");
    expect(state.model).toBeNull();
  });

  it("always sets effort to 'medium'", () => {
    const state = buildSeededModelState({
      textModel: "some-model",
      textTier: "precise",
    });
    expect(state.effort).toBe("medium");
  });

  it("defaults the budget to off when the seed omits it", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
    });
    expect(state.budgetEnabled).toBe(false);
    expect(state.budgetUsd).toBeNull();
    expect(state.budgetMode).toBe("prompt");
    expect(state.budgetGracePct).toBe(0.25);
  });

  it("seeds an enabled saved budget default", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
      budget: {
        enabled: true,
        limitUsd: 2,
        mode: "enforce",
        graceOveragePct: 0.5,
      },
    });
    expect(state.budgetEnabled).toBe(true);
    expect(state.budgetUsd).toBe(2);
    expect(state.budgetMode).toBe("enforce");
    expect(state.budgetGracePct).toBe(0.5);
  });

  it("normalizes budgetUsd to null when the saved default is disabled, even if limitUsd is set", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
      budget: {
        enabled: false,
        limitUsd: 5,
        mode: "prompt",
        graceOveragePct: 0.25,
      },
    });
    expect(state.budgetEnabled).toBe(false);
    expect(state.budgetUsd).toBeNull();
  });
});
