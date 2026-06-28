/**
 * Tests for embed/quantize.ts — quantizeToInt8 and dequantizeFromInt8.
 */
import { describe, it, expect } from "vitest";
import { quantizeToInt8, dequantizeFromInt8 } from "./quantize";

describe("quantizeToInt8", () => {
  it("returns empty Int8Array for empty input", () => {
    const result = quantizeToInt8([]);
    expect(result).toBeInstanceOf(Int8Array);
    expect(result.length).toBe(0);
  });

  it("returns all zeros when all values are equal (range = 0)", () => {
    const result = quantizeToInt8([0.5, 0.5, 0.5]);
    expect(result).toBeInstanceOf(Int8Array);
    expect(result.length).toBe(3);
    expect(Array.from(result)).toEqual([0, 0, 0]);
  });

  it("returns correct length for non-empty input", () => {
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const result = quantizeToInt8(embedding);
    expect(result.length).toBe(5);
  });

  it("maps minimum value to approximately -127", () => {
    const result = quantizeToInt8([0.0, 0.5, 1.0]);
    // Min (0.0) should map to -127
    expect(result[0]).toBe(-127);
  });

  it("maps maximum value to approximately 127", () => {
    const result = quantizeToInt8([0.0, 0.5, 1.0]);
    // Max (1.0) should map to 127
    expect(result[2]).toBe(127);
  });

  it("maps midpoint to approximately 0", () => {
    const result = quantizeToInt8([-1.0, 0.0, 1.0]);
    // Midpoint should be close to 0
    expect(Math.abs(result[1]!)).toBeLessThanOrEqual(1);
  });

  it("preserves ordering of values", () => {
    const result = quantizeToInt8([0.1, 0.3, 0.5, 0.7, 0.9]);
    // Should be monotonically non-decreasing
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(result[i - 1]!);
    }
  });

  it("handles negative values correctly", () => {
    const result = quantizeToInt8([-1.0, -0.5, 0.0, 0.5, 1.0]);
    expect(result.length).toBe(5);
    expect(result[0]).toBe(-127);
    expect(result[4]).toBe(127);
  });

  it("returns values within the Int8 range [-127, 127]", () => {
    const embedding = Array.from({ length: 100 }, (_, i) => Math.sin(i * 0.1));
    const result = quantizeToInt8(embedding);
    for (const v of result) {
      expect(v).toBeGreaterThanOrEqual(-128);
      expect(v).toBeLessThanOrEqual(127);
    }
  });

  it("produces an Int8Array (not a regular array)", () => {
    const result = quantizeToInt8([1.0, 2.0, 3.0]);
    expect(result).toBeInstanceOf(Int8Array);
  });
});

describe("dequantizeFromInt8", () => {
  it("round-trips a vector approximately", () => {
    const original = [0.1, 0.3, 0.5, 0.7, 0.9];
    const quantized = quantizeToInt8(original);
    const min = Math.min(...original);
    const max = Math.max(...original);
    const restored = dequantizeFromInt8(quantized, min, max);

    expect(restored).toHaveLength(original.length);
    // Should be within ~2% of original values (known quantization tolerance)
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(restored[i]! - original[i]!)).toBeLessThan(0.02);
    }
  });

  it("returns array of correct length", () => {
    const quantized = new Int8Array([0, 50, 100, 127]);
    const result = dequantizeFromInt8(quantized, 0.0, 1.0);
    expect(result).toHaveLength(4);
  });

  it("returns number array (not Int8Array)", () => {
    const quantized = new Int8Array([-127, 0, 127]);
    const result = dequantizeFromInt8(quantized, -1.0, 1.0);
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles empty Int8Array", () => {
    const result = dequantizeFromInt8(new Int8Array(0), 0, 1);
    expect(result).toHaveLength(0);
  });

  it("preserves ordering after round-trip", () => {
    const values = [0.1, 0.4, 0.6, 0.9];
    const min = 0.1;
    const max = 0.9;
    const quantized = quantizeToInt8(values);
    const restored = dequantizeFromInt8(quantized, min, max);
    for (let i = 1; i < restored.length; i++) {
      expect(restored[i]).toBeGreaterThanOrEqual(restored[i - 1]!);
    }
  });
});
