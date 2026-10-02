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

  // ADR-043 removed image and video generation, so the composer state carries
  // no generate mode, media tier or media model at all.
  it("carries no media-generation fields (ADR-043)", () => {
    expect(defaultModelState).not.toHaveProperty("generate");
    expect(defaultModelState).not.toHaveProperty("mediaTier");
    expect(defaultModelState).not.toHaveProperty("mediaModel");
    expect(defaultModelState).not.toHaveProperty("seededImageModel");
    expect(defaultModelState).not.toHaveProperty("seededVideoModel");
  });

  // ADR-235: no customer budget applies to the assistant, so the composer
  // state carries no per-turn budget.
  it("carries no per-turn budget fields (ADR-235)", () => {
    expect(defaultModelState).not.toHaveProperty("budgetEnabled");
    expect(defaultModelState).not.toHaveProperty("budgetUsd");
    expect(defaultModelState).not.toHaveProperty("budgetMode");
    expect(defaultModelState).not.toHaveProperty("budgetGracePct");
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
});
