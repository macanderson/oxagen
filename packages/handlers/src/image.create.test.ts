import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  generateImageFor: vi.fn(),
  selectImageModel: vi.fn(),
  persistGeneratedAsset: vi.fn(),
  requireEnv: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateImageFor: mocks.generateImageFor,
  selectImageModel: mocks.selectImageModel,
}));

vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persistGeneratedAsset,
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: mocks.requireEnv,
}));

// ── import under test ─────────────────────────────────────────────────────────

import { imageCreateHandler } from "./image.create";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: "msg_1",
};

const FAKE_MODEL = { modelId: "openai/gpt-image-1" };
const FAKE_ASSET = {
  id: "internal-uuid",
  publicId: "gen_abc123",
  kind: "image" as const,
  mimeType: "image/png",
  sizeBytes: 1024,
  url: "https://blob.store/abc.png",
  serveUrl: "/api/v1/assets/gen_abc123",
};

// ─────────────────────────────────────────────────────────────────────────────

describe("imageCreateHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gateway key is present
    mocks.requireEnv.mockReturnValue({ AI_GATEWAY_API_KEY: "gw_key" });
    mocks.selectImageModel.mockReturnValue(FAKE_MODEL);
    mocks.generateImageFor.mockResolvedValue({
      images: ["base64imagedata"],
      imageCount: 1,
      durationMs: 1200,
    });
    mocks.persistGeneratedAsset.mockResolvedValue(FAKE_ASSET);
  });

  it("returns image_id, url, and created_at on success", async () => {
    const result = await imageCreateHandler({ prompt: "A sunset", model: "gpt-image-1" }, CTX);

    expect(result.image_id).toBe("gen_abc123");
    expect(result.url).toBe("/api/v1/assets/gen_abc123");
    expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("calls generateImageFor with the correct prompt and model", async () => {
    await imageCreateHandler({ prompt: "A blue circle", model: "gpt-image-1" }, CTX);

    expect(mocks.selectImageModel).toHaveBeenCalledWith({ model: "openai/gpt-image-1" });
    expect(mocks.generateImageFor).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "A blue circle",
        size: "1024x1024",
      }),
    );
  });

  it("resolves flux-2-max to the correct gateway id", async () => {
    await imageCreateHandler({ prompt: "test", model: "flux-2-max" }, CTX);

    expect(mocks.selectImageModel).toHaveBeenCalledWith({ model: "bfl/flux-2-max" });
  });

  it("persists the asset with org access policy and correct fields", async () => {
    await imageCreateHandler({ prompt: "test prompt", model: "gpt-image-1" }, CTX);

    expect(mocks.persistGeneratedAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: "u_1",
        kind: "image",
        accessPolicy: "org",
        mimeType: "image/png",
        prompt: "test prompt",
        model: "openai/gpt-image-1",
      }),
    );
  });

  it("passes telemetry context to generateImageFor", async () => {
    await imageCreateHandler({ prompt: "test", model: "gpt-image-1" }, CTX);

    expect(mocks.generateImageFor).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({
          orgId: "org_1",
          workspaceId: "ws_1",
          surface: "api",
        }),
      }),
    );
  });

  it("returns a placeholder when AI_GATEWAY_API_KEY is missing", async () => {
    mocks.requireEnv.mockImplementation(() => {
      throw new Error("missing key");
    });

    const result = await imageCreateHandler({ prompt: "test", model: "gpt-image-1" }, CTX);

    expect(result.image_id).toMatch(/^placeholder_/);
    expect(result.url).toBe("https://placehold.co/1024x1024");
    expect(mocks.generateImageFor).not.toHaveBeenCalled();
  });

  it("returns a placeholder when generateImageFor returns no images", async () => {
    mocks.generateImageFor.mockResolvedValue({ images: [], imageCount: 0, durationMs: 500 });

    const result = await imageCreateHandler({ prompt: "test", model: "gpt-image-1" }, CTX);

    expect(result.image_id).toMatch(/^placeholder_/);
    expect(mocks.persistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("forwards the custom size to generateImageFor", async () => {
    await imageCreateHandler({ prompt: "test", model: "gpt-image-1", size: "512x512" }, CTX);

    expect(mocks.generateImageFor).toHaveBeenCalledWith(
      expect.objectContaining({ size: "512x512" }),
    );
  });
});
