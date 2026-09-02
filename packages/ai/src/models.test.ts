import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ───────────────────────────────────────────────────────
// vi.hoisted runs before any import resolution — refs are safe inside the
// vi.mock factory below. We mock the single AI seam: @ai-sdk/gateway. Every
// model is built through the gateway provider; there is no direct-provider path.
const mocks = vi.hoisted(() => ({
  languageInstance: { modelId: "anthropic/claude-sonnet-5" },
  imageInstance: { modelId: "openai/gpt-image-1" },
  videoInstance: { modelId: "google/veo-3.0-fast-generate-001" },
  languageModel: vi.fn(),
  imageModel: vi.fn(),
  video: vi.fn(),
}));

mocks.languageModel.mockReturnValue(mocks.languageInstance);
mocks.imageModel.mockReturnValue(mocks.imageInstance);
mocks.video.mockReturnValue(mocks.videoInstance);

vi.mock("@ai-sdk/gateway", () => ({
  gateway: {
    languageModel: mocks.languageModel,
    imageModel: mocks.imageModel,
    video: mocks.video,
  },
}));

// requireEnv is mocked to return whatever the current test set; the real schema
// carries only AI_GATEWAY_API_KEY + the OXAGEN_LLM_* tier vars now.
let envValues: Record<string, string | undefined> = {};

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => envValues,
}));

vi.mock("ai", () => ({
  wrapLanguageModel: (opts: { model: unknown }) => opts.model,
}));

import {
  selectModel,
  selectImageModel,
  selectVideoModel,
  imageTierModelId,
  videoTierModelId,
  resolvedTierCatalog,
} from "./models";

// ──────────────────────────────────────────────────────────────────

const resetMocks = () => {
  mocks.languageModel.mockClear();
  mocks.imageModel.mockClear();
  mocks.video.mockClear();
  mocks.languageModel.mockReturnValue(mocks.languageInstance);
  mocks.imageModel.mockReturnValue(mocks.imageInstance);
  mocks.video.mockReturnValue(mocks.videoInstance);
};

const TIER_ENV = {
  OXAGEN_LLM_FAST: "anthropic/claude-haiku-4.5",
  OXAGEN_LLM_BALANCED: "anthropic/claude-sonnet-5",
  OXAGEN_LLM_PRECISE: "anthropic/claude-opus-4.8",
};

describe("selectModel (@oxagen/ai) — gateway only", () => {
  beforeEach(resetMocks);

  it("routes through the gateway at the balanced tier by default", () => {
    envValues = { ...TIER_ENV };
    const model = selectModel();
    expect(mocks.languageModel).toHaveBeenCalledTimes(1);
    expect(mocks.languageModel).toHaveBeenCalledWith(
      "anthropic/claude-sonnet-5",
    );
    expect(model).toBe(mocks.languageInstance);
  });

  it("resolves the fast tier to its OXAGEN_LLM_FAST gateway id", () => {
    envValues = { ...TIER_ENV };
    selectModel({ tier: "fast" });
    expect(mocks.languageModel).toHaveBeenCalledWith(
      "anthropic/claude-haiku-4.5",
    );
  });

  it("resolves the precise tier to its OXAGEN_LLM_PRECISE gateway id", () => {
    envValues = { ...TIER_ENV };
    selectModel({ tier: "precise" });
    expect(mocks.languageModel).toHaveBeenCalledWith(
      "anthropic/claude-opus-4.8",
    );
  });

  it("an explicit gateway model id wins over a tier", () => {
    envValues = { ...TIER_ENV };
    selectModel({ model: "openai/gpt-5.2", tier: "fast" });
    expect(mocks.languageModel).toHaveBeenCalledWith("openai/gpt-5.2");
  });
});

describe("selectImageModel (@oxagen/ai) — gateway only", () => {
  beforeEach(resetMocks);

  it("defaults to the gateway gpt-image-1 model", () => {
    envValues = {};
    const model = selectImageModel();
    expect(mocks.imageModel).toHaveBeenCalledWith("openai/gpt-image-1");
    expect(model).toBe(mocks.imageInstance);
  });

  it("passes an explicit gateway image model id through", () => {
    envValues = {};
    selectImageModel({ model: "bfl/flux-2-max" });
    expect(mocks.imageModel).toHaveBeenCalledWith("bfl/flux-2-max");
  });
});

const MEDIA_ENV = {
  OXAGEN_LLM_IMAGE_BASIC: "openai/gpt-image-1",
  OXAGEN_LLM_IMAGE_ADVANCED: "bfl/flux-2-max",
  OXAGEN_LLM_VIDEO_BASIC: "google/veo-3.0-fast-generate-001",
  OXAGEN_LLM_VIDEO_ADVANCED: "google/veo-3.0-generate-001",
};

describe("media tier resolution (@oxagen/ai)", () => {
  beforeEach(resetMocks);

  it("resolves image tiers from OXAGEN_LLM_IMAGE_* env", () => {
    envValues = { ...MEDIA_ENV };
    expect(imageTierModelId("basic")).toBe("openai/gpt-image-1");
    expect(imageTierModelId("advanced")).toBe("bfl/flux-2-max");
  });

  it("resolves video tiers from OXAGEN_LLM_VIDEO_* env", () => {
    envValues = { ...MEDIA_ENV };
    expect(videoTierModelId("basic")).toBe("google/veo-3.0-fast-generate-001");
    expect(videoTierModelId("advanced")).toBe("google/veo-3.0-generate-001");
  });

  it("joins every tier to its concrete gateway model id", () => {
    envValues = { ...TIER_ENV, ...MEDIA_ENV };
    expect(resolvedTierCatalog()).toEqual({
      text: {
        fast: "anthropic/claude-haiku-4.5",
        balanced: "anthropic/claude-sonnet-5",
        precise: "anthropic/claude-opus-4.8",
      },
      image: { basic: "openai/gpt-image-1", advanced: "bfl/flux-2-max" },
      video: {
        basic: "google/veo-3.0-fast-generate-001",
        advanced: "google/veo-3.0-generate-001",
      },
    });
  });
});

describe("selectVideoModel (@oxagen/ai) — gateway only", () => {
  beforeEach(resetMocks);

  it("defaults to the basic tier Veo fast model", () => {
    envValues = { ...MEDIA_ENV };
    const model = selectVideoModel();
    expect(mocks.video).toHaveBeenCalledTimes(1);
    expect(mocks.video).toHaveBeenCalledWith(
      "google/veo-3.0-fast-generate-001",
    );
    expect(model).toBe(mocks.videoInstance);
  });

  it("resolves the advanced tier to OXAGEN_LLM_VIDEO_ADVANCED", () => {
    envValues = { ...MEDIA_ENV };
    selectVideoModel({ tier: "advanced" });
    expect(mocks.video).toHaveBeenCalledWith("google/veo-3.0-generate-001");
  });

  it("an explicit model id wins over a tier", () => {
    envValues = { ...MEDIA_ENV };
    selectVideoModel({ model: "google/veo-3.0-generate-001", tier: "basic" });
    expect(mocks.video).toHaveBeenCalledWith("google/veo-3.0-generate-001");
  });
});
