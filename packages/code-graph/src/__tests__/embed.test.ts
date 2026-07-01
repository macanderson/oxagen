import { describe, it, expect } from "vitest";
import {
  CODE_EMBED_MODEL,
  CODE_EMBED_GATEWAY_MODEL,
  CODE_EMBED_DIM,
  isValidCodeEmbedding,
  cosineSimilarity,
} from "../embed";

describe("code-graph embed contract", () => {
  it("pins the platform-wide model + dimension", () => {
    expect(CODE_EMBED_MODEL).toBe("text-embedding-3-small");
    expect(CODE_EMBED_GATEWAY_MODEL).toBe("openai/text-embedding-3-small");
    expect(CODE_EMBED_DIM).toBe(1536);
  });

  describe("isValidCodeEmbedding", () => {
    it("accepts a finite 1536-d vector", () => {
      expect(isValidCodeEmbedding(new Array(1536).fill(0.1))).toBe(true);
    });
    it("rejects the wrong dimension", () => {
      expect(isValidCodeEmbedding([0.1, 0.2])).toBe(false);
    });
    it("rejects non-arrays and non-finite entries", () => {
      expect(isValidCodeEmbedding("nope")).toBe(false);
      const bad = new Array(1536).fill(0);
      bad[0] = Number.NaN;
      expect(isValidCodeEmbedding(bad)).toBe(false);
    });
  });

  describe("cosineSimilarity", () => {
    it("is 1 for identical direction", () => {
      expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    });
    it("is 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    });
    it("returns 0 for a length mismatch or a zero vector", () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    });
    it("is negative for opposing vectors", () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    });
  });
});
