import { describe, expect, it } from "vitest";
import {
  drawing,
  hash32,
  hexPoints,
  lattice,
  PANEL_BAR,
  panel,
  prng,
  SUBJECTS,
  TREATMENTS,
  treatmentFor,
} from "./art.mjs";
import { INK } from "./theme.mjs";

/** every colour a generated image may carry: the ink table, and none */
const ALLOWED = new Set([...Object.values(INK), "none"]);

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
describe("lattice", () => {
  const box = { x: 0, y: 0, w: 800, h: 450, cell: 40 };

  it("tiles hairline cells evenly in the line tone, in three fading bands, with no fill and no gold", () => {
    const svg = lattice(box);
    expect(svg.match(/<polygon/g).length).toBeGreaterThan(100);
    expect(colours(svg)).toEqual([
      "none",
      INK.line,
      "none",
      INK.line,
      "none",
      INK.line,
    ]);
    expect(svg).not.toContain(INK.gold);
    const opacities = [...svg.matchAll(/stroke-opacity="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(opacities).toEqual([0.5, 0.28, 0.1]);
    expect(svg).not.toMatch(/gradient|fill-opacity/i);
  });

  it("covers the whole box: the first cell starts above and left of it", () => {
    const svg = lattice({ x: 100, y: 50, w: 400, h: 300, cell: 20 });
    // the first cell's top point is a row above the box
    expect(svg).toContain('points="80,');
  });

  it("puts a cell nearer the centre in a louder band than one at the edge", () => {
    const svg = lattice(box);
    const [centre, , edge] = svg.split("</g>");
    expect(centre).toContain("400,");
    expect(edge).toContain("0,");
  });

  it("is pure: the same box draws the same cells", () => {
    expect(lattice(box)).toBe(lattice(box));
  });
});

describe("panel", () => {
  const spec = { x: 100, y: 50, w: 600, h: 400, label: "audit ledger" };

  it("is a rounded card on a hairline with a title bar, two dim dots and one gold", () => {
    const { svg } = panel(spec);
    expect(svg).toContain(
      `<rect x="100" y="50" width="600" height="400" rx="12" fill="${INK.panel}" stroke="${INK.line}"`,
    );
    expect(svg).toContain(
      `<line x1="100" y1="${50 + PANEL_BAR}" x2="700" y2="${50 + PANEL_BAR}"`,
    );
    const fills = colours(svg);
    expect(fills.filter((c) => c === INK.dim)).toHaveLength(2);
    expect(fills.filter((c) => c === INK.gold)).toHaveLength(1);
    for (const c of fills) expect(ALLOWED.has(c)).toBe(true);
  });

  it("sets the label as outlines in the muted tone, upper-cased, and never as <text>", () => {
    const { svg } = panel(spec);
    expect(svg).toContain(`<g fill="${INK.muted}"`);
    expect(svg).not.toContain("<text");
    expect(panel(spec).svg).not.toBe(panel({ ...spec, label: "meter" }).svg);
  });

  it("returns the box a drawing may fill under the bar, on the panel's surface", () => {
    const { box } = panel({ ...spec, pad: 40 });
    expect(box).toEqual({
      x: 140,
      y: 50 + PANEL_BAR + 30,
      w: 520,
      h: 400 - PANEL_BAR - 60,
      surface: INK.panel,
    });
    const { box: dflt } = panel(spec);
    expect(dflt.x).toBe(140);
  });
});

describe("drawing", () => {
  const box = { x: 10, y: 20, w: 600, h: 500 };

  it("renders every treatment as a figure in the dim, muted and body tones, punched in the surface, with no gold", () => {
    for (const name of TREATMENTS) {
      const svg = drawing(name, { rand: prng(hash32(name)), ...box });
      expect(svg.startsWith(`<g fill="none" stroke="${INK.muted}"`)).toBe(true);
      expect(svg.length).toBeGreaterThan(400);
      const used = colours(svg);
      expect(used).not.toContain(INK.gold);
      expect(used).not.toContain(INK.ground);
      // every drawing but the log punches a hollow shape in the surface
      if (name !== "terminal") expect(used).toContain(INK.panel);
      for (const c of used) expect(ALLOWED.has(c)).toBe(true);
      expect(svg).not.toMatch(/gradient/i);
      expect(SUBJECTS[name]).toEqual(expect.any(String));
    }
  });

  it("punches hollows in the surface it is told about", () => {
    const svg = drawing("graph", {
      rand: prng(1),
      ...box,
      surface: INK.ground,
    });
    expect(colours(svg)).toContain(INK.ground);
    expect(colours(svg)).not.toContain(INK.panel);
  });

  it("scales off the box's height with a fifth over, so a wide box does not shrink it", () => {
    const wide = drawing("loop", {
      rand: prng(1),
      x: 0,
      y: 0,
      w: 1000,
      h: 300,
    });
    const square = drawing("loop", {
      rand: prng(1),
      x: 0,
      y: 0,
      w: 300,
      h: 300,
    });
    // the loop's outer ring radius is 0.34 of the scale
    expect(wide).toContain(`r="${Number((300 * 1.2 * 0.34).toFixed(1))}"`);
    expect(square).toContain(`r="${Number((300 * 0.34).toFixed(1))}"`);
  });

  it("differs by seed and rejects an unknown treatment", () => {
    expect(drawing("graph", { rand: prng(1), ...box })).not.toBe(
      drawing("graph", { rand: prng(2), ...box }),
    );
    expect(() => drawing("photo", { rand: prng(1), ...box })).toThrow(
      /unknown treatment/,
    );
  });

  it("draws the tool call as the log alone: the panel is the terminal", () => {
    const svg = drawing("terminal", { rand: prng(1), ...box });
    // no inner frame: the only rect is the cursor, filled in the body tone
    expect(svg.match(/<rect/g)).toHaveLength(1);
    expect(svg).toContain(`fill="${INK.body}" stroke="none"`);
  });
});
