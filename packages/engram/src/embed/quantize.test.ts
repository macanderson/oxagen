/**
 * Tests for embed/quantize.ts — symmetric Int8 quantization (R-1).
 *
 * The critical property is that cosine similarity survives the round-trip:
 * symmetric quantization preserves vector direction, so cosine(original,
 * dequantized) must stay > 0.99. The old asymmetric encoding failed this.
 */
import { describe, it, expect } from "vitest";
import { quantizeToInt8, dequantizeFromInt8 } from "./quantize";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("quantizeToInt8", () => {
  it("returns empty result for empty input", () => {
    const { quantized, scale } = quantizeToInt8([]);
    expect(quantized).toBeInstanceOf(Int8Array);
    expect(quantized.length).toBe(0);
    expect(scale).toBe(1);
  });

  it("returns all zeros with scale 1 for an all-zero vector", () => {
    const { quantized, scale } = quantizeToInt8([0, 0, 0]);
    expect(Array.from(quantized)).toEqual([0, 0, 0]);
    expect(scale).toBe(1);
  });

  it("maps the max-magnitude component to ±127 symmetrically", () => {
    const { quantized } = quantizeToInt8([-1.0, 0.0, 1.0]);
    expect(quantized[0]).toBe(-127);
    expect(quantized[1]).toBe(0);
    expect(quantized[2]).toBe(127);
  });

  it("keeps zero at zero (no per-vector offset shift)", () => {
    // Asymmetric encoding shifted 0 away from 0; symmetric must not.
    const { quantized } = quantizeToInt8([0.0, 0.25, 1.0]);
    expect(quantized[0]).toBe(0);
  });

  it("preserves ordering of values", () => {
    const { quantized } = quantizeToInt8([0.1, 0.3, 0.5, 0.7, 0.9]);
    for (let i = 1; i < quantized.length; i++) {
      expect(quantized[i]).toBeGreaterThanOrEqual(quantized[i - 1]!);
    }
  });

  it("stays within the Int8 range [-127, 127]", () => {
    const embedding = Array.from({ length: 100 }, (_, i) => Math.sin(i * 0.1));
    const { quantized } = quantizeToInt8(embedding);
    for (const v of quantized) {
      expect(v).toBeGreaterThanOrEqual(-127);
      expect(v).toBeLessThanOrEqual(127);
    }
  });
});

describe("dequantizeFromInt8", () => {
  it("round-trips a vector approximately using the stored scale", () => {
    const original = [0.1, -0.3, 0.5, -0.7, 0.9];
    const { quantized, scale } = quantizeToInt8(original);
    const restored = dequantizeFromInt8(quantized, scale);

    expect(restored).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      // Within one quantization step of the true value.
      expect(Math.abs(restored[i]! - original[i]!)).toBeLessThan(1 / scale + 1e-9);
    }
  });

  it("preserves cosine similarity > 0.99 after round-trip", () => {
    // A realistic-ish dense embedding with mixed signs and magnitudes.
    const original = Array.from({ length: 256 }, (_, i) =>
      Math.sin(i * 0.37) * 0.6 + Math.cos(i * 0.11) * 0.4,
    );
    const { quantized, scale } = quantizeToInt8(original);
    const restored = dequantizeFromInt8(quantized, scale);
    expect(cosine(original, restored)).toBeGreaterThan(0.99);
  });

  it("returns a number array (not Int8Array)", () => {
    const { quantized, scale } = quantizeToInt8([-1, 0, 1]);
    const result = dequantizeFromInt8(quantized, scale);
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles empty input", () => {
    expect(dequantizeFromInt8(new Int8Array(0), 1)).toHaveLength(0);
  });

  it("does not divide by zero when scale is 0", () => {
    const result = dequantizeFromInt8(new Int8Array([1, 2, 3]), 0);
    expect(result.every((v) => Number.isFinite(v))).toBe(true);
  });
});
