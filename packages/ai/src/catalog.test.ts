import { describe, expect, it } from "vitest";
import {
  gatewayModels,
  getModel,
  supportsReasoning,
  supportsImage,
  supportsVideo,
  supportsVision,
  supportsVideoInput,
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

  it("surfaces the latest Anthropic models (Fable 5, Sonnet 5) in the picker", () => {
    // Both are reasoning + vision + tools capable, 1M context, and text-selectable
    // so they appear in every gatewayModels-derived selector (chat picker, model
    // defaults settings). Guards against accidental removal when the catalog drifts.
    const fable = getModel("anthropic/claude-fable-5");
    const sonnet5 = getModel("anthropic/claude-sonnet-5");
    expect(fable?.name).toBe("Claude Fable 5");
    expect(sonnet5?.name).toBe("Claude Sonnet 5");
    for (const m of [fable, sonnet5]) {
      expect(m?.vendor).toBe("anthropic");
      expect(m?.context).toBe("1M");
      expect(supportsReasoning(m)).toBe(true);
      expect(supportsText(m)).toBe(true);
    }
  });

  it("reports reasoning support from the capability array", () => {
    // Opus is reasoning-capable; Haiku is not (per the catalog).
    expect(supportsReasoning("anthropic/claude-opus-4.8")).toBe(true);
    expect(supportsReasoning("anthropic/claude-haiku-4.5")).toBe(false);
    // Unknown ids are conservatively false — the caller can't describe them.
    expect(supportsReasoning("unknown/model")).toBe(false);
    expect(supportsReasoning(undefined)).toBe(false);
  });

  it("distinguishes vision (image input) from image generation", () => {
    // Claude/GPT chat models take image INPUT (vision) but do not GENERATE images.
    expect(supportsVision("anthropic/claude-opus-4.8")).toBe(true);
    expect(supportsImage("anthropic/claude-opus-4.8")).toBe(false);
    // A pure image-generation model is not a vision (input) model.
    expect(supportsVision("openai/gpt-image-1")).toBe(false);
    // Unknown / undefined are conservatively false.
    expect(supportsVision("unknown/model")).toBe(false);
    expect(supportsVision(undefined)).toBe(false);
  });

  it("distinguishes video INPUT (Gemini) from video generation (Veo)", () => {
    // Gemini accepts video file parts as input; it does not generate video.
    expect(supportsVideoInput("google/gemini-3-pro")).toBe(true);
    expect(supportsVideoInput("google/gemini-3-flash")).toBe(true);
    expect(supportsVideo("google/gemini-3-pro")).toBe(false);
    // Veo generates video but does not accept video input in chat.
    expect(supportsVideoInput("google/veo-3.0-generate-001")).toBe(false);
    // Non-Gemini vision models take images but not video input.
    expect(supportsVideoInput("anthropic/claude-opus-4.8")).toBe(false);
    expect(supportsVideoInput(undefined)).toBe(false);
  });

  it("classifies image vs video vs text capability", () => {
    expect(supportsImage("openai/gpt-image-1")).toBe(true);
    expect(supportsImage("anthropic/claude-opus-4.8")).toBe(false);
    expect(supportsVideo("google/veo-3.0-generate-001")).toBe(true);
    expect(supportsVideo("openai/gpt-image-1")).toBe(false);
    // Pure media models are NOT text-capable; chat models are.
    expect(supportsText("openai/gpt-image-1")).toBe(false);
    expect(supportsText("google/veo-3.0-generate-001")).toBe(false);
    expect(supportsText("anthropic/claude-opus-4.8")).toBe(true);
  });

  it("supportsMedia dispatches on kind", () => {
    expect(supportsMedia("openai/gpt-image-1", "image")).toBe(true);
    expect(supportsMedia("openai/gpt-image-1", "video")).toBe(false);
    expect(supportsMedia("google/veo-3.0-generate-001", "video")).toBe(true);
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
    expect(TEXT_TIERS.map((t) => t.id)).toEqual([
      "fast",
      "balanced",
      "precise",
    ]);
    expect(TEXT_TIERS[0]?.name).toBe("Oxagen Fast");
    expect(MEDIA_TIERS.map((t) => t.id)).toEqual(["basic", "advanced"]);
  });

  it("every media env default resolves to a media-capable catalog entry", () => {
    // Guards the env defaults (env.ts) against drift from the catalog — a basic
    // image default that isn't an image model would silently break generation.
    expect(supportsImage("openai/gpt-image-1")).toBe(true); // OXAGEN_LLM_IMAGE_BASIC
    expect(supportsImage("bfl/flux-2-max")).toBe(true); // OXAGEN_LLM_IMAGE_ADVANCED
    expect(supportsVideo("google/veo-3.0-fast-generate-001")).toBe(true); // OXAGEN_LLM_VIDEO_BASIC
    expect(supportsVideo("google/veo-3.0-generate-001")).toBe(true); // OXAGEN_LLM_VIDEO_ADVANCED
  });
});
