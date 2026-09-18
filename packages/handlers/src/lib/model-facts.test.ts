import { describe, expect, it } from "vitest";
import {
  modelFactsOf,
  modelProviderOf,
  modelTierOf,
} from "./model-facts";

describe("modelProviderOf", () => {
  it("reads the vendor out of a bare Anthropic id", () => {
    expect(modelProviderOf("claude-haiku-4-5-20251001")).toBe("anthropic");
  });

  it("reads the vendor out of a bare OpenAI id", () => {
    expect(modelProviderOf("gpt-5-mini")).toBe("openai");
  });

  it("reads the vendor out of a bare Google id", () => {
    expect(modelProviderOf("gemini-2.5-pro")).toBe("google");
  });

  it("reads the vendor out of a gateway provider/model slug", () => {
    expect(modelProviderOf("anthropic/claude-sonnet-5")).toBe("anthropic");
  });

  it("answers undefined for an id it does not recognise", () => {
    expect(modelProviderOf("some-internal-model-v3")).toBeUndefined();
  });
});

describe("modelTierOf", () => {
  it.each([
    ["claude-haiku-4-5-20251001", "haiku"],
    ["claude-sonnet-5", "sonnet"],
    ["claude-opus-4-1-20250805", "opus"],
    ["anthropic/claude-fable-5", "fable"],
    ["gpt-5-mini", "mini"],
    ["gpt-5-nano", "nano"],
    ["openai:o3-mini", "mini"],
    ["gemini-2.5-pro", "pro"],
    ["google/gemini-2.5-flash", "flash"],
  ])("reads %s as %s", (id, tier) => {
    expect(modelTierOf(id)).toBe(tier);
  });

  it("prefers the compound class over the token inside it", () => {
    expect(modelTierOf("gemini-2.5-flash-lite")).toBe("flash-lite");
  });

  it("answers undefined for an id that names no class", () => {
    expect(modelTierOf("gpt-5")).toBeUndefined();
  });

  it("answers undefined for an id it does not know", () => {
    expect(modelTierOf("some-internal-model-v3")).toBeUndefined();
  });

  it("does not read a class word buried inside a longer word", () => {
    expect(modelTierOf("prometheus-1")).toBeUndefined();
  });

  it("answers undefined for an empty model segment", () => {
    expect(modelTierOf("anthropic/")).toBeUndefined();
  });
});

describe("modelFactsOf", () => {
  it("carries the id as recorded and both derived facts", () => {
    expect(modelFactsOf("claude-haiku-4-5-20251001")).toEqual({
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      tier: "haiku",
    });
  });

  it("resolves a gateway slug without rewriting the recorded id", () => {
    expect(modelFactsOf("google/gemini-2.5-flash")).toEqual({
      id: "google/gemini-2.5-flash",
      provider: "google",
      tier: "flash",
    });
  });

  it("nulls the halves it cannot name rather than guessing", () => {
    expect(modelFactsOf("some-internal-model-v3")).toEqual({
      id: "some-internal-model-v3",
      provider: null,
      tier: null,
    });
  });

  it("names the vendor of an id that carries no class", () => {
    expect(modelFactsOf("gpt-5")).toEqual({
      id: "gpt-5",
      provider: "openai",
      tier: null,
    });
  });

  it("answers null when the record holds no model", () => {
    expect(modelFactsOf(null)).toBeNull();
    expect(modelFactsOf(undefined)).toBeNull();
    expect(modelFactsOf("   ")).toBeNull();
  });
});
