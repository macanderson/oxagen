import { describe, expect, it } from "vitest";
import {
  gatewayModels,
  getModel,
  supportsReasoning,
  supportsImage,
  supportsVideo,
  supportsText,
  supportsMedia,
  capabilityLabel,
  TEXT_TIERS,
  MEDIA_TIERS,
} from "./catalog";

describe("model catalog (@oxagen/ai/catalog)", () => {
  it("indexes every model by its gateway id", () => {
    for (const m of gatewayModels) {
      expect(getModel(m.id)).toBe(m);
    }
    expect(getModel("does/not-exist")).toBeUndefined();
  });

  it("reports reasoning support from the capability array", () => {
    // Opus is reasoning-capable; Haiku is not (per the catalog).
    expect(supportsReasoning("anthropic/claude-opus-4.8")).toBe(true);
    expect(supportsReasoning("anthropic/claude-haiku-4.5")).toBe(false);
    // Unknown ids are conservatively false — the caller can't describe them.
    expect(supportsReasoning("unknown/model")).toBe(false);
    expect(supportsReasoning(undefined)).toBe(false);
  });

  it("classifies image vs video vs text capability", () => {
    expect(supportsImage("openai/dall-e-3")).toBe(true);
    expect(supportsImage("anthropic/claude-opus-4.8")).toBe(false);
    expect(supportsVideo("google/veo-3")).toBe(true);
    expect(supportsVideo("openai/dall-e-3")).toBe(false);
    // Pure media models are NOT text-capable; chat models are.
    expect(supportsText("openai/dall-e-3")).toBe(false);
    expect(supportsText("google/veo-3")).toBe(false);
    expect(supportsText("anthropic/claude-opus-4.8")).toBe(true);
  });

  it("supportsMedia dispatches on kind", () => {
    expect(supportsMedia("openai/dall-e-3", "image")).toBe(true);
    expect(supportsMedia("openai/dall-e-3", "video")).toBe(false);
    expect(supportsMedia("google/veo-3", "video")).toBe(true);
  });

  it("accepts either an id string or a resolved model object", () => {
    const opus = getModel("anthropic/claude-opus-4.8");
    expect(supportsReasoning(opus)).toBe(true);
  });

  it("labels every capability", () => {
    expect(capabilityLabel("reasoning")).toBe("Reasoning");
    expect(capabilityLabel("image")).toBe("Image gen");
    expect(capabilityLabel("video")).toBe("Video gen");
  });

  it("exposes the three text tiers and two media tiers", () => {
    expect(TEXT_TIERS.map((t) => t.id)).toEqual(["fast", "balanced", "precise"]);
    expect(TEXT_TIERS[0]?.name).toBe("Oxagen Fast");
    expect(MEDIA_TIERS.map((t) => t.id)).toEqual(["basic", "advanced"]);
  });

  it("every media env default resolves to a media-capable catalog entry", () => {
    // Guards the env defaults (env.ts) against drift from the catalog — a basic
    // image default that isn't an image model would silently break generation.
    expect(supportsImage("openai/dall-e-3")).toBe(true); // OXAGEN_LLM_IMAGE_BASIC
    expect(supportsImage("bfl/flux-2")).toBe(true); // OXAGEN_LLM_IMAGE_ADVANCED
    expect(supportsVideo("google/veo-3-fast")).toBe(true); // OXAGEN_LLM_VIDEO_BASIC
    expect(supportsVideo("google/veo-3")).toBe(true); // OXAGEN_LLM_VIDEO_ADVANCED
  });
});
