import { describe, it, expect } from "vitest";
import { chunkText } from "./chunk";

describe("chunkText", () => {
  it("returns no chunks for empty/whitespace input", () => {
    expect(chunkText("").chunks).toHaveLength(0);
    expect(chunkText("   \n  \n").chunks).toHaveLength(0);
  });

  it("returns a single chunk for content under the size cap", () => {
    const { chunks, truncated } = chunkText("line one\nline two\nline three");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("line one");
    expect(chunks[0]!.text).toContain("line three");
    expect(chunks[0]!.startLine).toBe(0);
    expect(truncated).toBe(false);
  });

  it("splits large content into multiple line-aligned, overlapping chunks", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`);
    const { chunks } = chunkText(lines.join("\n"), { maxChars: 300, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    // Indices are sequential from 0.
    chunks.forEach((c, i) => expect(c.index).toBe(i));
    // Consecutive chunks overlap: chunk[1] starts at or before chunk[0]'s end.
    expect(chunks[1]!.startLine).toBeLessThanOrEqual(chunks[0]!.endLine);
    // Every line is covered by some chunk (line 199 appears in the last chunk).
    expect(chunks[chunks.length - 1]!.text).toContain("x199");
  });

  it("respects maxChunks and flags truncation", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `row ${i}`);
    const { chunks, truncated } = chunkText(lines.join("\n"), {
      maxChars: 100,
      overlapChars: 0,
      maxChunks: 5,
    });
    expect(chunks).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it("always advances so a single oversized line still terminates", () => {
    const huge = "x".repeat(10_000);
    const { chunks } = chunkText(`${huge}\nshort`, { maxChars: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // The oversized first line is emitted as its own chunk.
    expect(chunks[0]!.text.length).toBeGreaterThan(100);
  });
});
