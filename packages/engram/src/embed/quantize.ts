/**
 * Float32 → Int8 vector quantization for storage-efficient embeddings.
 *
 * Uses SYMMETRIC quantization: `scale = 127 / max(|v|)`, `q = round(v * scale)`.
 * Symmetric encoding preserves the direction of the vector, so cosine
 * similarity — which is direction-only — survives round-trip to within a
 * fraction of a percent.
 *
 * The previous asymmetric encoding (`(v - min) * scale - 127`) shifted every
 * component by a per-vector offset, which rotates the vector and destroys
 * cosine similarity; it also discarded the scale/offset, making dequantization
 * impossible to do correctly. We now keep the single `scale` alongside the
 * bytes so dequantization is exact up to rounding.
 */

/** A quantized vector plus the scale needed to reconstruct it. */
export interface QuantizedVector {
  /** Int8 components: `round(v * scale)`, clamped to [-127, 127]. */
  quantized: Int8Array;
  /** Reconstruction scale: `float ≈ int8 / scale` (scale = 127 / max|v|). */
  scale: number;
}

/**
 * Quantize a float32 embedding vector to Int8 using symmetric scaling.
 * Returns the bytes and the scale required to dequantize them.
 */
export function quantizeToInt8(embedding: number[]): QuantizedVector {
  if (embedding.length === 0) return { quantized: new Int8Array(0), scale: 1 };

  let maxAbs = 0;
  for (const v of embedding) {
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }

  // All-zero vector: nothing to scale. Use scale=1 so dequantization yields
  // zeros rather than dividing by zero.
  if (maxAbs === 0) return { quantized: new Int8Array(embedding.length), scale: 1 };

  const scale = 127 / maxAbs;
  const result = new Int8Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    // Clamp guards the edge where |v| === maxAbs rounds to ±127 exactly, and
    // any FP drift that could push a component to ±128 (out of Int8 range).
    const q = Math.round(embedding[i]! * scale);
    result[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return { quantized: result, scale };
}

/**
 * Dequantize an Int8 vector back to approximate float32 using the scale
 * captured at quantization time (`float ≈ int8 / scale`).
 */
export function dequantizeFromInt8(quantized: Int8Array, scale: number): number[] {
  const inv = scale === 0 ? 0 : 1 / scale;
  const result = new Array<number>(quantized.length);
  for (let i = 0; i < quantized.length; i++) {
    result[i] = quantized[i]! * inv;
  }
  return result;
}
