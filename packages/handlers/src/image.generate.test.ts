import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  requireEnv: vi.fn(),
  generateImageFor: vi.fn(),
  selectImageModel: vi.fn(),
  persistGeneratedAsset: vi.fn(),
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

// Persistence seam — successful generations are stored as conversation files
// through persistGeneratedAsset (mocked; the seam has its own tests).
vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persistGeneratedAsset,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── import under test ─────────────────────────────────────────────────────────

import { imageGenerateHandler } from "./image.generate";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── fixtures ──────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const fakeModel = {
  type: "image-model",
  modelId: "openai/gpt-image-1",
} as const;

// ─────────────────────────────────────────────────────────────────────────────

describe("imageGenerateHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectImageModel.mockReturnValue(fakeModel);
    // Default: persistence succeeds.
    mocks.persistGeneratedAsset.mockResolvedValue({
      id: "uuid-1",
      publicId: "gen_img1",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 100,
      key: "generated/images/org_1/x.png",
      url: "blob://x",
      serveUrl: "/api/v1/assets/gen_img1",
    });
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
      images: ["AAABBA=="],
      imageCount: 1,
      durationMs: 123,
    });

    const result = await imageGenerateHandler(
      { prompt: "A mountain", alt: "Mountain photo", size: "1024x1024" },
      CTX,
    );

    expect(result.placeholder).toBe(false);
    expect(result.dataUri).toBe("data:image/png;base64,AAABBA==");
    expect(result.alt).toBe("Mountain photo");
    expect(result.render.componentId).toBe("image-preview");
    expect(result.render.props["dataUri"]).toBe(
      "data:image/png;base64,AAABBA==",
    );
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
    mocks.generateImageFor.mockRejectedValueOnce(
      new Error("Rate limit exceeded"),
    );

    const result = await imageGenerateHandler({ prompt: "A city" }, CTX);

    expect(result.placeholder).toBe(true);
    expect(result.render.componentId).toBe("image-preview");
    expect(result.render.props["placeholder"]).toBe(true);
  });

  // ── Conversation-file persistence ───────────────────────────────────────────

  it("persists the generated image as an org-visible conversation file", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: "vck_gateway" });
    mocks.generateImageFor.mockResolvedValueOnce({
      images: ["AAABBA=="],
      imageCount: 1,
      durationMs: 123,
    });

    const result = await imageGenerateHandler(
      { prompt: "A mountain" },
      { ...CTX, messageId: "msg_7" },
    );

    expect(mocks.persistGeneratedAsset).toHaveBeenCalledTimes(1);
    const args = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args["kind"]).toBe("image");
    expect(args["mimeType"]).toBe("image/png");
    expect(args["accessPolicy"]).toBe("org");
    expect(args["userId"]).toBe("u_1");
    expect(args["messageId"]).toBe("msg_7");
    // Model id comes from the resolved gateway model, never a hard-coded slug.
    expect(args["model"]).toBe("openai/gpt-image-1");
    expect(Buffer.from(args["bytes"] as Uint8Array).toString("base64")).toBe(
      "AAABBA==",
    );

    expect(result.assetPublicId).toBe("gen_img1");
    expect(result.serveUrl).toBe("/api/v1/assets/gen_img1");
    // The render directive prefers the access-controlled serving URL.
    expect(result.render.props["url"]).toBe("/api/v1/assets/gen_img1");
    expect(result.render.props["dataUri"]).toBe(
      "data:image/png;base64,AAABBA==",
    );
  });

  it("persistence failure is non-fatal: data URI returned with persistWarning", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: "vck_gateway" });
    mocks.generateImageFor.mockResolvedValueOnce({
      images: ["AAABBA=="],
      imageCount: 1,
      durationMs: 50,
    });
    mocks.persistGeneratedAsset.mockRejectedValueOnce(new Error("blob down"));

    const result = await imageGenerateHandler({ prompt: "A city" }, CTX);

    expect(result.placeholder).toBe(false);
    expect(result.dataUri).toBe("data:image/png;base64,AAABBA==");
    expect(result.assetPublicId).toBeUndefined();
    expect(result.serveUrl).toBeUndefined();
    expect(result.persistWarning).toContain("could not be saved");
    expect(result.render.props["url"]).toBeUndefined();
  });

  it("skips persistence with a warning when there is no user identity", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: "vck_gateway" });
    mocks.generateImageFor.mockResolvedValueOnce({
      images: ["AAABBA=="],
      imageCount: 1,
      durationMs: 50,
    });

    const result = await imageGenerateHandler(
      { prompt: "test" },
      { ...CTX, userId: null },
    );

    expect(mocks.persistGeneratedAsset).not.toHaveBeenCalled();
    expect(result.persistWarning).toContain("no user identity");
    expect(result.dataUri).toBe("data:image/png;base64,AAABBA==");
  });

  it("does not attempt persistence when generation returned no image", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: "vck_gateway" });
    mocks.generateImageFor.mockResolvedValueOnce({
      images: [undefined],
      imageCount: 1,
      durationMs: 80,
    });

    const result = await imageGenerateHandler({ prompt: "Abstract art" }, CTX);

    expect(mocks.persistGeneratedAsset).not.toHaveBeenCalled();
    expect(result.assetPublicId).toBeUndefined();
  });

  it("derives alt from the prompt when alt is not supplied", async () => {
    mocks.requireEnv.mockReturnValueOnce({ AI_GATEWAY_API_KEY: undefined });

    const result = await imageGenerateHandler(
      { prompt: "A very long prompt describing the desired image in detail" },
      CTX,
    );

    expect(result.alt.length).toBeLessThanOrEqual(120);
    expect(result.alt).toBe(
      "A very long prompt describing the desired image in detail",
    );
  });
});
