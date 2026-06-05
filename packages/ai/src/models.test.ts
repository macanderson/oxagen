import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ───────────────────────────────────────────────────────
// vi.hoisted runs before any import resolution — refs are safe inside
// vi.mock factories below.
const mocks = vi.hoisted(() => ({
  anthropicInstance: { modelId: "claude-sonnet-4-6" },
  openaiInstance: { modelId: "gpt-4o" },
  anthropicFactory: vi.fn(),
  openaiFactory: vi.fn(),
  createAnthropic: vi.fn(),
  createOpenAI: vi.fn(),
}));

// Default factory implementations: return a model object whose modelId we can
// inspect; the shape is sufficient for LanguageModel duck-typing in tests.
mocks.anthropicFactory.mockReturnValue(mocks.anthropicInstance);
mocks.openaiFactory.mockReturnValue(mocks.openaiInstance);
mocks.createAnthropic.mockReturnValue(mocks.anthropicFactory);
mocks.createOpenAI.mockReturnValue(mocks.openaiFactory);

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: mocks.anthropicFactory,
  createAnthropic: mocks.createAnthropic,
}));
vi.mock("@ai-sdk/openai", () => ({
  openai: mocks.openaiFactory,
  createOpenAI: mocks.createOpenAI,
}));

// ── env stubs: two variants — both keys present, and keys absent ─────────────
let envValues: Record<string, string | undefined> = {};

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => envValues,
}));

import {
  selectModel,
  imageTierModelId,
  videoTierModelId,
  resolvedTierCatalog,
} from "./models";

// ──────────────────────────────────────────────────────────────────

const resetMocks = () => {
  mocks.anthropicFactory.mockClear();
  mocks.openaiFactory.mockClear();
  mocks.createAnthropic.mockClear();
  mocks.createOpenAI.mockClear();
  mocks.createAnthropic.mockReturnValue(mocks.anthropicFactory);
  mocks.createOpenAI.mockReturnValue(mocks.openaiFactory);
};

describe("selectModel (@oxagen/ai)", () => {
  beforeEach(resetMocks);

  // ── Anthropic path ───────────────────────────────────────────────

  it("defaults to anthropic provider and claude-sonnet-4-6 when no selector given", () => {
    envValues = { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: undefined };
    const model = selectModel();
    // createAnthropic called with the injected key
    expect(mocks.createAnthropic).toHaveBeenCalledTimes(1);
    expect(mocks.createAnthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-test" });
    // factory then called with the default model id
    expect(mocks.anthropicFactory).toHaveBeenCalledWith("claude-sonnet-4-6");
    expect(model).toBe(mocks.anthropicInstance);
    // OpenAI never touched
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
  });

  it("falls back to bare anthropic() when ANTHROPIC_API_KEY is absent", () => {
    // With no key the code path takes the early-return branch using the default
    // `anthropic` export (not a createAnthropic client).
    envValues = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };
    const model = selectModel({ provider: "anthropic" });
    // createAnthropic must NOT be called — the SDK's default export is used
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    // The bare factory IS called with the default model
    expect(mocks.anthropicFactory).toHaveBeenCalledWith("claude-sonnet-4-6");
    expect(model).toBe(mocks.anthropicInstance);
  });

  it("respects an explicit anthropic model override", () => {
    envValues = { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: undefined };
    selectModel({ provider: "anthropic", model: "claude-3-haiku-20240307" });
    expect(mocks.anthropicFactory).toHaveBeenCalledWith("claude-3-haiku-20240307");
  });

  // ── OpenAI path ────────────────────────────────────────────────────

  it("selects openai provider and gpt-4o when provider=openai and key present", () => {
    envValues = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "sk-oai-test" };
    const model = selectModel({ provider: "openai" });
    expect(mocks.createOpenAI).toHaveBeenCalledTimes(1);
    expect(mocks.createOpenAI).toHaveBeenCalledWith({ apiKey: "sk-oai-test" });
    expect(mocks.openaiFactory).toHaveBeenCalledWith("gpt-4o");
    expect(model).toBe(mocks.openaiInstance);
    // Anthropic never touched
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
  });

  it("falls back to bare openai() when OPENAI_API_KEY is absent", () => {
    envValues = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };
    selectModel({ provider: "openai" });
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.openaiFactory).toHaveBeenCalledWith("gpt-4o");
  });

  it("respects an explicit openai model override", () => {
    envValues = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "sk-oai-test" };
    selectModel({ provider: "openai", model: "gpt-4-turbo" });
    expect(mocks.openaiFactory).toHaveBeenCalledWith("gpt-4-turbo");
  });

  // ── Isolation: one provider call does not pollute the other ──────────────

  it("does not call OpenAI factories when provider=anthropic", () => {
    envValues = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" };
    selectModel({ provider: "anthropic" });
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.openaiFactory).not.toHaveBeenCalled();
  });

  it("does not call Anthropic factories when provider=openai", () => {
    envValues = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" };
    selectModel({ provider: "openai" });
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.anthropicFactory).not.toHaveBeenCalled();
  });

  // ── Vercel AI Gateway path (AI_GATEWAY_API_KEY present) ───────────────────

  const GATEWAY_ENV = {
    AI_GATEWAY_API_KEY: "vck_gateway_test",
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-oai",
    OXAGEN_LLM_FAST: "anthropic/claude-haiku-4.5",
    OXAGEN_LLM_BALANCED: "anthropic/claude-sonnet-4.6",
    OXAGEN_LLM_PRECISE: "anthropic/claude-opus-4.8",
  };

  it("routes through the gateway (balanced tier default) when AI_GATEWAY_API_KEY is set", () => {
    envValues = { ...GATEWAY_ENV };
    selectModel();
    // gateway client built against the OpenAI-compatible base URL with the token
    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: "vck_gateway_test",
      baseURL: "https://ai-gateway.vercel.sh/v1",
      name: "vercel-ai-gateway",
    });
    // default tier resolves to the balanced gateway model id
    expect(mocks.openaiFactory).toHaveBeenCalledWith("anthropic/claude-sonnet-4.6");
    // no direct anthropic client when the gateway handles the call
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
  });

  it("resolves the fast tier to its OXAGEN_LLM_FAST gateway id", () => {
    envValues = { ...GATEWAY_ENV };
    selectModel({ tier: "fast" });
    expect(mocks.openaiFactory).toHaveBeenCalledWith("anthropic/claude-haiku-4.5");
  });

  it("resolves the precise tier to its OXAGEN_LLM_PRECISE gateway id", () => {
    envValues = { ...GATEWAY_ENV };
    selectModel({ tier: "precise" });
    expect(mocks.openaiFactory).toHaveBeenCalledWith("anthropic/claude-opus-4.8");
  });

  it("an explicit gateway model id wins over a tier", () => {
    envValues = { ...GATEWAY_ENV };
    selectModel({ model: "openai/gpt-5.2", tier: "fast" });
    expect(mocks.openaiFactory).toHaveBeenCalledWith("openai/gpt-5.2");
  });
});

const MEDIA_ENV = {
  OXAGEN_LLM_IMAGE_BASIC: "openai/gpt-image-1",
  OXAGEN_LLM_IMAGE_ADVANCED: "bfl/flux-2-max",
  OXAGEN_LLM_VIDEO_BASIC: "google/veo-3-fast",
  OXAGEN_LLM_VIDEO_ADVANCED: "google/veo-3",
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
    expect(videoTierModelId("basic")).toBe("google/veo-3-fast");
    expect(videoTierModelId("advanced")).toBe("google/veo-3");
  });

  it("joins every tier to its concrete gateway model id", () => {
    envValues = { ...GATEWAY_ENV_FOR_CATALOG, ...MEDIA_ENV };
    expect(resolvedTierCatalog()).toEqual({
      text: {
        fast: "anthropic/claude-haiku-4.5",
        balanced: "anthropic/claude-sonnet-4.6",
        precise: "anthropic/claude-opus-4.8",
      },
      image: { basic: "openai/gpt-image-1", advanced: "bfl/flux-2-max" },
      video: { basic: "google/veo-3-fast", advanced: "google/veo-3" },
    });
  });
});

// resolvedTierCatalog reads text + media tiers; the env mock returns the whole
// object regardless of requested keys, so provide both sets together.
const GATEWAY_ENV_FOR_CATALOG = {
  OXAGEN_LLM_FAST: "anthropic/claude-haiku-4.5",
  OXAGEN_LLM_BALANCED: "anthropic/claude-sonnet-4.6",
  OXAGEN_LLM_PRECISE: "anthropic/claude-opus-4.8",
};
