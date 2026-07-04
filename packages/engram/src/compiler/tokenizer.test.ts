/**
 * Tests for model-family-accurate token counting.
 *
 * Covers the real vendor-tokenizer routing (tiktoken for OpenAI,
 * @anthropic-ai/tokenizer for Anthropic), the character-based fallback for
 * unknown families, and the fail-safe degradation to the estimator when a
 * tokenizer cannot be loaded.
 */
import { describe, it, expect, vi } from "vitest";
import {
  getTokenizer,
  countTokens,
  CharBasedTokenizer,
  TiktokenTokenizer,
  AnthropicTokenizer,
  type TokenEncoder,
} from "./tokenizer";

describe("getTokenizer routing", () => {
  it("routes the OpenAI family to a tiktoken-backed tokenizer", () => {
    const tok = getTokenizer("openai/gpt-4o");
    expect(tok.modelFamily).toBe("openai");
  });

  it("routes the Anthropic family to an @anthropic-ai/tokenizer-backed tokenizer", () => {
    const tok = getTokenizer("anthropic/claude-sonnet-5");
    expect(tok.modelFamily).toBe("anthropic");
  });

  it("routes an unknown family to the character-based estimator", () => {
    const tok = getTokenizer("google/gemini-3.0-pro");
    expect(tok.modelFamily).toBe("estimate");
    // Estimator is deterministic: ceil(len / 3.8), min 1.
    const text = "the quick brown fox";
    expect(tok.count(text)).toBe(new CharBasedTokenizer(3.8).count(text));
  });

  it("caches a tokenizer instance per encoding key", () => {
    const a = getTokenizer("openai/gpt-4o");
    const b = getTokenizer("openai/gpt-4o-mini"); // same o200k_base encoding
    expect(a).toBe(b);
  });
});

describe("real vendor tokenizers differ from the naive char estimate", () => {
  // BPE merges long runs of an identical character far more aggressively than
  // the ~4-chars-per-token heuristic, so the real count is strictly below the
  // estimate for this input — a structurally guaranteed divergence that does
  // not depend on a hard-coded token count.
  const repeated = "a".repeat(100);

  it("OpenAI: real tiktoken count is a positive integer below the estimate", () => {
    const real = countTokens(repeated, "openai/gpt-4o");
    const estimate = new CharBasedTokenizer(4.0).count(repeated);
    expect(Number.isInteger(real)).toBe(true);
    expect(real).toBeGreaterThan(0);
    expect(real).toBeLessThan(estimate);
  });

  it("Anthropic: real tokenizer count is a positive integer below the estimate", () => {
    const real = countTokens(repeated, "anthropic/claude-sonnet-5");
    const estimate = new CharBasedTokenizer(3.5).count(repeated);
    expect(Number.isInteger(real)).toBe(true);
    expect(real).toBeGreaterThan(0);
    expect(real).toBeLessThan(estimate);
  });
});

describe("real encoder path is exercised (injected loader)", () => {
  it("TiktokenTokenizer uses the encoder's encode() output, loaded lazily once", () => {
    const encoder: TokenEncoder = { encode: () => ({ length: 42 }) };
    const load = vi.fn(() => encoder);
    const tok = new TiktokenTokenizer("openai/gpt-4o", load);

    // Lazy: not loaded until the first count().
    expect(load).not.toHaveBeenCalled();
    expect(tok.count("anything")).toBe(42);
    expect(tok.count("again")).toBe(42);
    // Encoder memoized: loaded exactly once across multiple counts.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("AnthropicTokenizer uses the injected counter, loaded lazily once", () => {
    const counter = vi.fn(() => 7);
    const load = vi.fn(() => counter);
    const tok = new AnthropicTokenizer(load);

    expect(load).not.toHaveBeenCalled();
    expect(tok.count("hello")).toBe(7);
    expect(tok.count("world")).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
    expect(counter).toHaveBeenCalledTimes(2);
  });
});

describe("failed tokenizer load falls back to the char estimator", () => {
  const text = "the quick brown fox jumps over the lazy dog";

  it("TiktokenTokenizer falls back (4.0 chars/token) without throwing when load fails", () => {
    const load = vi.fn(() => {
      throw new Error("wasm unavailable");
    });
    const tok = new TiktokenTokenizer("openai/gpt-4o", load);
    const expected = new CharBasedTokenizer(4.0).count(text);
    expect(() => tok.count(text)).not.toThrow();
    expect(tok.count(text)).toBe(expected);
    // A failed load is memoized: no repeated load attempts.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("AnthropicTokenizer falls back (3.5 chars/token) without throwing when load fails", () => {
    const load = vi.fn(() => {
      throw new Error("dep missing");
    });
    const tok = new AnthropicTokenizer(load);
    const expected = new CharBasedTokenizer(3.5).count(text);
    expect(() => tok.count(text)).not.toThrow();
    expect(tok.count(text)).toBe(expected);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("TiktokenTokenizer falls back when a per-call encode() throws", () => {
    const encoder: TokenEncoder = {
      encode: () => {
        throw new Error("encode boom");
      },
    };
    const tok = new TiktokenTokenizer("openai/gpt-4o", () => encoder);
    const expected = new CharBasedTokenizer(4.0).count(text);
    expect(() => tok.count(text)).not.toThrow();
    expect(tok.count(text)).toBe(expected);
  });
});
