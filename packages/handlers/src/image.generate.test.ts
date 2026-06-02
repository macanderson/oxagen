import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  requireEnv: vi.fn(),
  generateImageFor: vi.fn(),
  createOpenAI: vi.fn(),
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: mocks.requireEnv,
}));

// The handler delegates all generation to generateImageFor in @oxagen/ai.
vi.mock("@oxagen/ai", () => ({
  generateImageFor: mocks.generateImageFor,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mocks.createOpenAI,
}));

// ── import under test ─────────────────────────────────────────────────────────

import { imageGenerateHandler } from "./image.generate";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("imageGenerateHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a placeholder when OPENAI_API_KEY is absent", async () => {
    mocks.requireEnv.mockReturnValueOnce({ OPENAI_API_KEY: undefined });

    const result = await imageGenerateHandler(
      { prompt: "A sunset", size: "1024x1024" },
      CTX,
    );

    expect(result.placeholder).toBe(true);
    expect(result.dataUri).toBeUndefined();
    expect(result.alt).toContain("sunset");
    expect(result.render.componentId).toBe("image-preview");
    expect(result.render.props["placeholder"]).toBe(true);
  });

  it("returns a placeholder and does not throw when requireEnv throws", async () => {
    mocks.requireEnv.mockImplementationOnce(() => {
      throw new Error("OPENAI_API_KEY not set");
    });

    const result = await imageGenerateHandler({ prompt: "A landscape" }, CTX);

    expect(result.placeholder).toBe(true);
    expect(result.render.componentId).toBe("image-preview");
  });

  it("returns a data URI on successful generation", async () => {
    mocks.requireEnv.mockReturnValueOnce({ OPENAI_API_KEY: "sk-test-key" });

    const fakeModel = { type: "image-model" };
    const fakeClient = { image: vi.fn().mockReturnValue(fakeModel) };
    mocks.createOpenAI.mockReturnValueOnce(fakeClient);
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
  });

  it("passes ctx.surface directly to generateImageFor (no surface re-map)", async () => {
    mocks.requireEnv.mockReturnValueOnce({ OPENAI_API_KEY: "sk-test-key" });

    const fakeModel = { type: "image-model" };
    const fakeClient = { image: vi.fn().mockReturnValue(fakeModel) };
    mocks.createOpenAI.mockReturnValueOnce(fakeClient);
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
    mocks.requireEnv.mockReturnValueOnce({ OPENAI_API_KEY: "sk-test-key" });

    const fakeClient = { image: vi.fn().mockReturnValue({}) };
    mocks.createOpenAI.mockReturnValueOnce(fakeClient);
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
    mocks.requireEnv.mockReturnValueOnce({ OPENAI_API_KEY: "sk-test-key" });

    const fakeClient = { image: vi.fn().mockReturnValue({}) };
    mocks.createOpenAI.mockReturnValueOnce(fakeClient);
    mocks.generateImageFor.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const result = await imageGenerateHandler({ prompt: "A city" }, CTX);

    expect(result.placeholder).toBe(true);
    expect(result.render.componentId).toBe("image-preview");
    expect(result.render.props["placeholder"]).toBe(true);
  });

  it("derives alt from the prompt when alt is not supplied", async () => {
    mocks.requireEnv.mockReturnValueOnce({ OPENAI_API_KEY: undefined });

    const result = await imageGenerateHandler(
      { prompt: "A very long prompt describing the desired image in detail" },
      CTX,
    );

    expect(result.alt.length).toBeLessThanOrEqual(120);
    expect(result.alt).toBe("A very long prompt describing the desired image in detail");
  });
});
