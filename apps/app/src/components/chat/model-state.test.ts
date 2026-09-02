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
  it("has generate = null (text chat mode)", () => {
    expect(defaultModelState.generate).toBeNull();
  });

  it("has tier = 'fast'", () => {
    expect(defaultModelState.tier).toBe("fast");
  });

  it("has model = null", () => {
    expect(defaultModelState.model).toBeNull();
  });

  it("has effort = 'medium'", () => {
    expect(defaultModelState.effort).toBe("medium");
  });

  it("has mediaTier = 'basic'", () => {
    expect(defaultModelState.mediaTier).toBe("basic");
  });

  it("has mediaModel = null", () => {
    expect(defaultModelState.mediaModel).toBeNull();
  });

  it("has seededImageModel = null", () => {
    expect(defaultModelState.seededImageModel).toBeNull();
  });

  it("has seededVideoModel = null", () => {
    expect(defaultModelState.seededVideoModel).toBeNull();
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
      imageModel: null,
      videoModel: null,
    });
    expect(state.model).toBe("claude-sonnet-5");
    expect(state.tier).toBeNull();
  });

  it("falls back to textTier when textModel is null", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: "balanced",
      imageModel: null,
      videoModel: null,
    });
    expect(state.model).toBeNull();
    expect(state.tier).toBe("balanced");
  });

  it("defaults tier to 'fast' when both textModel and textTier are null", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
      imageModel: null,
      videoModel: null,
    });
    expect(state.tier).toBe("fast");
    expect(state.model).toBeNull();
  });

  it("stores seededImageModel", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
      imageModel: "flux-2-max",
      videoModel: null,
    });
    expect(state.seededImageModel).toBe("flux-2-max");
  });

  it("stores seededVideoModel", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
      imageModel: null,
      videoModel: "veo-3.0",
    });
    expect(state.seededVideoModel).toBe("veo-3.0");
  });

  it("starts in text mode regardless of seeded media models", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
      imageModel: "gpt-image-1",
      videoModel: "veo-3.0",
    });
    expect(state.generate).toBeNull();
    expect(state.mediaModel).toBeNull();
    expect(state.mediaTier).toBe("basic");
  });

  it("always sets effort to 'medium'", () => {
    const state = buildSeededModelState({
      textModel: "some-model",
      textTier: "precise",
      imageModel: null,
      videoModel: null,
    });
    expect(state.effort).toBe("medium");
  });

  it("defaults the budget to off when the seed omits it", () => {
    const state = buildSeededModelState({
      textModel: null,
      textTier: null,
      imageModel: null,
      videoModel: null,
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
      imageModel: null,
      videoModel: null,
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
      imageModel: null,
      videoModel: null,
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
