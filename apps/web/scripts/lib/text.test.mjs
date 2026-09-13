import { describe, expect, it } from "vitest";
import { measure, textPath, wrap } from "./text.mjs";

describe("measure", () => {
  it("measures in px and grows with size, weight and tracking", () => {
    const w = measure("oxagen", { size: 20 });
    expect(w).toBeGreaterThan(40);
    expect(w).toBeLessThan(120);
    expect(measure("oxagen", { size: 40 })).toBeCloseTo(w * 2, 5);
    expect(measure("oxagen", { size: 20, weight: 700 })).not.toBe(w);
    expect(measure("oxagen", { size: 20, tracking: 0.1 })).toBeCloseTo(
      w + 6 * 0.1 * 20,
      5,
    );
    expect(measure("", { size: 20 })).toBe(0);
  });
});

describe("wrap", () => {
  const o = { size: 20, weight: 600, maxWidth: 200, maxLines: 3 };

  it("breaks on spaces and keeps every line within the width", () => {
    const lines = wrap(
      "What an ontology buys an agent that answers from the wrong context",
      o,
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line, o)).toBeLessThanOrEqual(200);
  });

  it("returns one line for text that fits, and none for empty text", () => {
    expect(wrap("Short", o)).toEqual(["Short"]);
    expect(wrap("   ", o)).toEqual([]);
  });

  it("ellipsises the last permitted line", () => {
    const lines = wrap(
      "a title so long that three lines of two hundred pixels cannot possibly hold all of these many words",
      o,
    );
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith("…")).toBe(true);
    expect(measure(lines[2], o)).toBeLessThanOrEqual(200);
  });

  it("hyphenates a word wider than a line", () => {
    const lines = wrap("Supercalifragilisticexpialidocious", {
      ...o,
      maxWidth: 120,
    });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].endsWith("-")).toBe(true);
    for (const line of lines) expect(measure(line, o)).toBeLessThanOrEqual(120);
  });
});

describe("textPath", () => {
  it("emits outlines, not <text>, scaled to the size and flipped to y-down", () => {
    const svg = textPath("ox", { x: 10, y: 50, size: 20, fill: "#000" });
    expect(svg).not.toContain("<text");
    expect(svg).toMatch(
      /^<g fill="#000" transform="translate\(10\.0 50\) scale\(0\.02000 -0\.02000\)">/,
    );
    expect(svg.match(/<path d="M/g)).toHaveLength(2);
  });

  it("right-aligns on x with anchor end and skips blank glyphs", () => {
    const start = textPath("a b", { x: 100, y: 0, size: 20, fill: "#000" });
    const end = textPath("a b", {
      x: 100,
      y: 0,
      size: 20,
      fill: "#000",
      anchor: "end",
    });
    expect(start).toContain("translate(100.0 0)");
    expect(end).not.toContain("translate(100.0 0)");
    expect(end.match(/<path d="M/g)).toHaveLength(2);
  });
});
