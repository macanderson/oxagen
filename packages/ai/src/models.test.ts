import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ────────────────────────────────────────────────────────────
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

import { selectModel } from "./models";

// ─────────────────────────────────────────────────────────────────────────────

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

  // ── Anthropic path ───────────────────────────────────────────────────────

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

  // ── OpenAI path ──────────────────────────────────────────────────────────

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
});
