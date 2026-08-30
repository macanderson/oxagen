/**
 * Direct-Anthropic provider — proves gateway slugs map to Anthropic model ids,
 * non-Anthropic vendors fail with the actionable AnthropicOnlyModelError, the
 * global AI SDK default provider is installed idempotently, and capability
 * gaps (embeddings, images) fail with clear messages instead of opaque 404s.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ProviderV4 } from "@ai-sdk/provider";
import {
  AnthropicOnlyModelError,
  installDirectAnthropicProvider,
  toDirectAnthropicModelId,
  uninstallDirectAnthropicProviderForTests,
} from "../anthropic-direct.js";

function globalProvider(): ProviderV4 | undefined {
  return (globalThis as { AI_SDK_DEFAULT_PROVIDER?: ProviderV4 })
    .AI_SDK_DEFAULT_PROVIDER;
}

beforeEach(() => uninstallDirectAnthropicProviderForTests());
afterEach(() => uninstallDirectAnthropicProviderForTests());

describe("toDirectAnthropicModelId", () => {
  it("strips the anthropic/ gateway prefix", () => {
    expect(toDirectAnthropicModelId("anthropic/claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    );
  });

  it("passes bare ids through unchanged", () => {
    expect(toDirectAnthropicModelId("claude-haiku-4.5")).toBe(
      "claude-haiku-4.5",
    );
  });

  it("throws AnthropicOnlyModelError for other vendors", () => {
    expect(() => toDirectAnthropicModelId("openai/gpt-5.5-pro")).toThrow(
      AnthropicOnlyModelError,
    );
    expect(() => toDirectAnthropicModelId("google/gemini-3-pro")).toThrow(
      /AI_GATEWAY_API_KEY/,
    );
  });
});

describe("installDirectAnthropicProvider", () => {
  it("installs a global default provider that resolves anthropic slugs", () => {
    installDirectAnthropicProvider("sk-ant-test");
    const provider = globalProvider();
    expect(provider).toBeDefined();
    const model = provider!.languageModel("anthropic/claude-sonnet-5");
    expect(model.modelId).toBe("claude-sonnet-5");
    expect(model.provider).toContain("anthropic");
  });

  it("is idempotent — the first installed provider wins", () => {
    installDirectAnthropicProvider("sk-ant-first");
    const first = globalProvider();
    installDirectAnthropicProvider("sk-ant-second");
    expect(globalProvider()).toBe(first);
  });

  it("rejects non-Anthropic language models with the actionable error", () => {
    installDirectAnthropicProvider("sk-ant-test");
    expect(() => globalProvider()!.languageModel("openai/gpt-5.5-pro")).toThrow(
      AnthropicOnlyModelError,
    );
  });

  it("fails embeddings and image models with clear messages", () => {
    installDirectAnthropicProvider("sk-ant-test");
    expect(() =>
      globalProvider()!.embeddingModel("openai/text-embedding-3-small"),
    ).toThrow(/no.*embeddings endpoint/i);
    expect(() => globalProvider()!.imageModel("openai/gpt-image-1")).toThrow(
      /no.*image-generation endpoint/i,
    );
  });
});
