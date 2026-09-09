import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ───────────────────────────────────────────────────────
// vi.hoisted runs before any import resolution — refs are safe inside the
// vi.mock factory below. We mock the single AI seam: @ai-sdk/gateway. Every
// model is built through the gateway provider; there is no direct-provider path.
const mocks = vi.hoisted(() => ({
  languageInstance: { modelId: "anthropic/claude-sonnet-5" },
  languageModel: vi.fn(),
}));

mocks.languageModel.mockReturnValue(mocks.languageInstance);

vi.mock("@ai-sdk/gateway", () => ({
  gateway: { languageModel: mocks.languageModel },
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

import { selectModel, resolvedTierCatalog } from "./models";

// ──────────────────────────────────────────────────────────────────

const resetMocks = () => {
  mocks.languageModel.mockClear();
  mocks.languageModel.mockReturnValue(mocks.languageInstance);
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

describe("tier resolution (@oxagen/ai)", () => {
  beforeEach(resetMocks);

  // ADR-043 removed image and video GENERATION, and with it the media tiers
  // and their OXAGEN_LLM_{IMAGE,VIDEO}_* env keys. Text is the only white-
  // labeled tier family left.
  it("joins every tier to its concrete gateway model id — text only", () => {
    envValues = { ...TIER_ENV };
    expect(resolvedTierCatalog()).toEqual({
      text: {
        fast: "anthropic/claude-haiku-4.5",
        balanced: "anthropic/claude-sonnet-5",
        precise: "anthropic/claude-opus-4.8",
      },
    });
  });
});
