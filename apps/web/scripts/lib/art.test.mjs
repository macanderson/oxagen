import { describe, expect, it } from "vitest";
import {
  drawing,
  hash32,
  hexPoints,
  honeycomb,
  prng,
  TREATMENTS,
  treatmentFor,
} from "./art.mjs";
import { theme, THEMES } from "./theme.mjs";

const ALLOWED = new Set(
  THEMES.flatMap((n) => {
    const t = theme(n);
    return [t.ground, t.panel, t.raised, t.line, t.rule, t.dim, t.gold, "none"];
  }),
);

function colours(svg) {
  return [...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6}|none)"/g)].map(
    (m) => m[1],
  );
}

describe("seeding", () => {
  it("hashes and draws the same numbers for the same seed", () => {
    expect(hash32("a")).toBe(hash32("a"));
    expect(hash32("a")).not.toBe(hash32("b"));
    const a = prng(hash32("x"));
    const b = prng(hash32("x"));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("picks one of the seven treatments per seed, and all seven over many seeds", () => {
    expect(TREATMENTS).toHaveLength(7);
    expect(treatmentFor("post")).toBe(treatmentFor("post"));
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(treatmentFor(`seed-${i}`));
    expect([...seen].sort()).toEqual([...TREATMENTS].sort());
  });
});

describe("hexPoints", () => {
  it("is a pointy-top hexagon in the mark's proportions", () => {
    const pts = hexPoints(100, 100, 10)
      .split(" ")
      .map((p) => p.split(",").map(Number));
    expect(pts).toHaveLength(6);
    expect(pts[0]).toEqual([100, 100 - Number((10 * (6.64 / 6.3)).toFixed(1))]);
    expect(pts[1][0]).toBe(110);
    expect(pts[4][0]).toBe(90);
  });
});

describe("honeycomb", () => {
  const box = { x: 0, y: 0, w: 800, h: 450, cell: 40, density: 0.5 };

  it("draws cells in the theme's flat tones with exactly one in gold", () => {
    for (const name of THEMES) {
      const t = theme(name);
      const svg = honeycomb({ rand: prng(1), t, ...box });
      const fills = colours(svg);
      expect(fills.filter((c) => c === t.gold)).toHaveLength(1);
      for (const c of fills) expect(ALLOWED.has(c)).toBe(true);
      expect(svg).not.toMatch(/gradient|opacity/i);
      expect(svg.match(/<polygon/g).length).toBeGreaterThan(10);
    }
  });

  it("can leave the gold out, and tilts about the box's centre", () => {
    const t = theme("dark");
    const svg = honeycomb({ rand: prng(2), t, ...box, gold: false, tilt: 5 });
    expect(colours(svg)).not.toContain(t.gold);
    expect(svg).toContain("rotate(5.00 400 225)");
  });

  it("is deterministic for a seed", () => {
    const t = theme("dark");
    expect(honeycomb({ rand: prng(3), t, ...box })).toBe(
      honeycomb({ rand: prng(3), t, ...box }),
    );
  });
});

describe("drawing", () => {
  const box = { x: 10, y: 20, w: 600, h: 500 };

  it("renders every treatment in every theme with hairlines in the quiet tones and no gold", () => {
    for (const name of TREATMENTS) {
      for (const themeName of THEMES) {
        const t = theme(themeName);
        const svg = drawing(name, { rand: prng(hash32(name)), t, ...box });
        expect(svg.startsWith('<g fill="none" stroke="')).toBe(true);
        expect(svg.length).toBeGreaterThan(400);
        expect(colours(svg)).not.toContain(t.gold);
        for (const c of colours(svg)) expect(ALLOWED.has(c)).toBe(true);
        expect(svg).not.toMatch(/gradient/i);
      }
    }
  });

  it("differs by seed and rejects an unknown treatment", () => {
    const t = theme("dark");
    expect(drawing("graph", { rand: prng(1), t, ...box })).not.toBe(
      drawing("graph", { rand: prng(2), t, ...box }),
    );
    expect(() => drawing("photo", { rand: prng(1), t, ...box })).toThrow(
      /unknown treatment/,
    );
  });
});
