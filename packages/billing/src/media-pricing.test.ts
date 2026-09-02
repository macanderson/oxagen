import { describe, expect, it } from "vitest";
import {
  imageProviderCostUsd,
  imageProviderCostUsdMicros,
  videoProviderCostUsd,
  videoProviderCostUsdMicros,
  IMAGE_FALLBACK_RATE,
  VIDEO_FALLBACK_RATE,
} from "./pricing";

// The media rate card prices image/video generation PER ASSET. These tests pin
// the cost derivation: exact model match, longest-prefix family match, size
// multipliers, per-second video scaling, and the over-charge fallback for
// unknown models (a missing entry must never bill $0).

describe("imageProviderCostUsd", () => {
  it("prices a known model per image at its base size", () => {
    // gpt-image-1 = $0.04/image at 1024x1024.
    expect(
      imageProviderCostUsd("openai/gpt-image-1", 1, "1024x1024"),
    ).toBeCloseTo(0.04, 10);
    expect(imageProviderCostUsd("openai/gpt-image-1", 3)).toBeCloseTo(0.12, 10);
  });

  it("applies the HD size multiplier", () => {
    // 1536x1024 multiplier is 1.5 → $0.06.
    expect(
      imageProviderCostUsd("openai/gpt-image-1", 1, "1536x1024"),
    ).toBeCloseTo(0.06, 10);
  });

  it("matches a model family by longest prefix", () => {
    // "bfl/flux-2-max" exact = $0.08; an unlisted flux-2 variant falls to the
    // "bfl/flux-2" family ($0.06), and any other flux to "bfl/flux" ($0.05).
    expect(imageProviderCostUsd("bfl/flux-2-max", 1)).toBeCloseTo(0.08, 10);
    expect(imageProviderCostUsd("bfl/flux-2-pro", 1)).toBeCloseTo(0.06, 10);
    expect(imageProviderCostUsd("bfl/flux-pro-1.1", 1)).toBeCloseTo(0.05, 10);
  });

  it("over-charges (never $0) for an unknown model via the fallback", () => {
    expect(imageProviderCostUsd("acme/unknown-image", 1)).toBeCloseTo(
      IMAGE_FALLBACK_RATE.usdPerImage,
      10,
    );
    expect(imageProviderCostUsd("acme/unknown-image", 1)).toBeGreaterThan(0);
  });

  it("never returns negative cost for a non-positive image count", () => {
    expect(imageProviderCostUsd("openai/gpt-image-1", 0)).toBe(0);
    expect(imageProviderCostUsd("openai/gpt-image-1", -2)).toBe(0);
  });

  it("converts to micro-USD", () => {
    expect(imageProviderCostUsdMicros("bfl/flux-2-max", 2)).toBe(160_000); // 2 × $0.08
  });
});

describe("videoProviderCostUsd", () => {
  it("prices per second of output", () => {
    // veo-3.0-fast = $0.35/sec.
    expect(
      videoProviderCostUsd("google/veo-3.0-fast-generate-001", 5),
    ).toBeCloseTo(1.75, 10);
    expect(videoProviderCostUsd("google/veo-3.0-generate-001", 4)).toBeCloseTo(
      3.0,
      10,
    );
  });

  it("prices Sora 2 per second, pro tier at its own rate", () => {
    // sora-2 = $0.10/sec, sora-2-pro = $0.50/sec (longest-prefix match).
    expect(videoProviderCostUsd("openai/sora-2", 12)).toBeCloseTo(1.2, 10);
    expect(videoProviderCostUsd("openai/sora-2-pro", 12)).toBeCloseTo(6.0, 10);
  });

  it("uses the model's default duration when seconds are omitted or invalid", () => {
    // defaultSeconds is 5 for veo-3.0-fast → 5 × $0.35.
    expect(
      videoProviderCostUsd("google/veo-3.0-fast-generate-001"),
    ).toBeCloseTo(1.75, 10);
    expect(
      videoProviderCostUsd("google/veo-3.0-fast-generate-001", 0),
    ).toBeCloseTo(1.75, 10);
  });

  it("over-charges (never $0) for an unknown model via the fallback", () => {
    const expected =
      VIDEO_FALLBACK_RATE.usdPerSecond * VIDEO_FALLBACK_RATE.defaultSeconds;
    expect(videoProviderCostUsd("acme/unknown-video")).toBeCloseTo(
      expected,
      10,
    );
    expect(videoProviderCostUsd("acme/unknown-video")).toBeGreaterThan(0);
  });

  it("converts to micro-USD", () => {
    expect(
      videoProviderCostUsdMicros("google/veo-3.0-fast-generate-001", 5),
    ).toBe(1_750_000);
  });
});
