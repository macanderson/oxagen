/**
 * Tests for compiler/model-family.ts (T-1): the shared family resolver must
 * classify OpenAI reasoning models (o1/o3/o4 and their -mini variants) as
 * "openai" — the old duplicated `includes("o1")` check missed o3-mini/o4-mini,
 * silently routing them to the character estimator.
 */
import { describe, it, expect } from "vitest";
import { resolveFamily } from "./model-family";

describe("resolveFamily", () => {
  it.each([
    ["gpt-4o", "openai"],
    ["gpt-4o-mini", "openai"],
    ["gpt-3.5-turbo", "openai"],
    ["o1", "openai"],
    ["o1-preview", "openai"],
    ["o3", "openai"],
    ["o3-mini", "openai"],
    ["o4-mini", "openai"],
    ["openai/o3-mini", "openai"],
    ["claude-sonnet-5", "anthropic"],
    ["anthropic/claude-fable-5", "anthropic"],
    ["gemini-2.5-pro", "google"],
    ["google/gemini-flash", "google"],
    ["llama-3-70b", "default"],
    ["mistral-large", "default"],
  ])("resolves %s → %s", (modelId, family) => {
    expect(resolveFamily(modelId)).toBe(family);
  });

  it("does not misclassify gpt-4o as a reasoning model (gpt branch wins)", () => {
    // Guards the \bo[134] boundary regex against matching the trailing 'o' in
    // gpt-4o — it must land on openai via the gpt branch, not via o-reasoning.
    expect(resolveFamily("gpt-4o")).toBe("openai");
  });
});
