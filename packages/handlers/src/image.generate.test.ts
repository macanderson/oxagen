import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  requireEnv: vi.fn(),
  generateImageFor: vi.fn(),
  selectImageModel: vi.fn(),
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: mocks.requireEnv,
}));

// The handler delegates all generation to generateImageFor in @oxagen/ai, and
// obtains its ImageModel from selectImageModel() — the single AI chokepoint for
// image-model construction (builds the Vercel AI Gateway client internally).
vi.mock("@oxagen/ai", () => ({
  generateImageFor: mocks.generateImageFor,
  selectImageModel: mocks.selectImageModel,
}));

// ── import under test ─────────────────────────────────────────────────────────

import { imageGenerateHandler } from "./image.generate";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── fixtures ──────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const fakeModel = { type: "image-model" } as const;

// ─────────────────────────────────────────────────────────────────────────────

describe("imageGenerateHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectImageModel.mockReturnValue(fakeModel);
  });

  it("returns a placeholder when AI_GATEWAY_API_KEY is absent", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: undefined });

    const result = await imageGenerateHandler(
      { prompt: "A sunset", size: "1024x1024" },
      CTX,
    );

    expect(result.placeholder).toBe(true);
    expect(result.dataUri).toBeUndefined();
    expect(result.alt).toContain("sunset");
    expect(result.render.componentId).toBe("image-preview");
    expect(result.render.props["placeholder"]).toBe(true);
    // No model is built / no generation attempted without the gateway key.
    expect(mocks.selectImageModel).not.toHaveBeenCalled();
    expect(mocks.generateImageFor).not.toHaveBeenCalled();
  });

  it("returns a placeholder and does not throw when requireEnv throws", async () => {
    mocks.requireEnv.mockImplementationOnce(() => {
      throw new Error("AI_GATEWAY_API_KEY not set");
    });

    const result = await imageGenerateHandler({ prompt: "A landscape" }, CTX);

    expect(result.placeholder).toBe(true);
    expect(result.render.componentId).toBe("image-preview");
  });

  it("returns a data URI on successful generation", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: "vck_gateway" });
    mocks.generateImageFor.mockResolvedValueOnce({
      images: ["AAABBB"],
      imageCount: 1,
      durationMs: 123,
    });

    const result = await imageGenerateHandler(
      { prompt: "A mountain", alt: "Mountain photo", size: "1024x1024" },
      CTX,
    );

    expect(result.placeholder).toBe(false);
    expect(result.dataUri).toBe("data:image/png;base64,AAABBB");
    expect(result.alt).toBe("Mountain photo");
    expect(result.render.componentId).toBe("image-preview");
    expect(result.render.props["dataUri"]).toBe("data:image/png;base64,AAABBB");
    expect(mocks.selectImageModel).toHaveBeenCalledTimes(1);
  });

  it("passes ctx.surface directly to generateImageFor (no surface re-map)", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: "vck_gateway" });
    mocks.generateImageFor.mockResolvedValueOnce({
      images: ["BASE64DATA"],
      imageCount: 1,
      durationMs: 50,
    });

    const appCtx: CapabilityContext = { ...CTX, surface: "app" };
    await imageGenerateHandler({ prompt: "Test" }, appCtx);

    const arg = mocks.generateImageFor.mock.calls[0]?.[0] as {
      telemetry?: { surface?: string };
    };
    expect(arg?.telemetry?.surface).toBe("app");
  });

  it("returns placeholder when generateImageFor returns no base64", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: "vck_gateway" });
    mocks.generateImageFor.mockResolvedValueOnce({
      images: [undefined],
      imageCount: 1,
      durationMs: 80,
    });

    const result = await imageGenerateHandler({ prompt: "Abstract art" }, CTX);

    // No base64 — dataUri is undefined but placeholder should still be false
    // (generation succeeded, caller decides what to do with undefined dataUri).
    expect(result.placeholder).toBe(false);
    expect(result.dataUri).toBeUndefined();
  });

  it("returns a placeholder and does not throw when generateImageFor throws", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: "vck_gateway" });
    mocks.generateImageFor.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const result = await imageGenerateHandler({ prompt: "A city" }, CTX);

    expect(result.placeholder).toBe(true);
    expect(result.render.componentId).toBe("image-preview");
    expect(result.render.props["placeholder"]).toBe(true);
  });

  it("derives alt from the prompt when alt is not supplied", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: undefined });

    const result = await imageGenerateHandler(
      { prompt: "A very long prompt describing the desired image in detail" },
      CTX,
    );

    expect(result.alt.length).toBeLessThanOrEqual(120);
    expect(result.alt).toBe("A very long prompt describing the desired image in detail");
  });
});
