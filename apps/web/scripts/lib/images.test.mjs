import { describe, expect, it } from "vitest";
import { SUBJECTS, TREATMENTS } from "./art.mjs";
import {
  BANNER,
  bannerSvg,
  CLEAR,
  FOCUS,
  OG,
  ogSvg,
  THUMB,
  wordmark,
} from "./images.mjs";
import { INK } from "./theme.mjs";

const gold = (svg) => (svg.match(/fill="#D6962C"/g) ?? []).length;
const paper = /fill="#F2EEE5"|fill="#F8F5EE"/g;

describe("sizes", () => {
  it("are the ones the site and the networks expect", () => {
    expect(BANNER).toEqual({ w: 2400, h: 1200 });
    expect(THUMB).toEqual({ w: 960, h: 480 });
    expect(OG).toEqual({ w: 1200, h: 630 });
  });
});

describe("wordmark", () => {
  it("nests the brand file, letters in the text tone and the x in gold", () => {
    const svg = wordmark({ x: 10, y: 20, height: 30 });
    expect(svg).toMatch(
      /^<svg x="10" y="20" width="146\.0" height="30" viewBox="0 0 453\.868 93\.246">/,
    );
    expect(svg).toContain('fill="#F2EEE5"');
    expect(svg).toContain('fill="#D6962C"');
    expect(svg).not.toContain("<style");
  });
});

describe("bannerSvg", () => {
  it("is a full-bleed field on ink: rings, blocks, halo, one gold cell, and a drawing, with no panel", () => {
    const svg = bannerSvg({ seed: "a-post" });
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="2400" height="1200"/,
    );
    expect(svg).toContain(
      `<rect width="2400" height="1200" fill="${INK.ground}"/>`,
    );
    expect(svg).not.toContain('rx="12"');
    expect(svg).not.toContain(`fill="${INK.panel}"`);
    expect(gold(svg)).toBe(1);
    expect(svg).toContain(`<g fill="${INK.line}" stroke="none">`);
    expect(svg).toContain('stroke-width="2" stroke-opacity="0.6"');
    expect(svg).toContain('<g fill="none" stroke=');
    expect(svg).not.toMatch(/gradient|<text/i);
  });

  it("never has a paper surface", () => {
    for (const treatment of TREATMENTS) {
      const svg = bannerSvg({ seed: "a-post", treatment });
      // paper appears only as the wordmark's letters, and a banner has none
      expect(svg.match(paper)).toBeNull();
    }
  });

  it("keeps the drawing right of centre and inside the middle 21:9 band a wide hero crops to", () => {
    expect(FOCUS.x - CLEAR.x).toBeGreaterThan(0.4);
    expect(FOCUS.x + CLEAR.x).toBeLessThanOrEqual(1);
    // 2400 wide at 21:9 is 1029 tall: rows 86 to 1114
    expect((FOCUS.y - CLEAR.y) * 1200).toBeGreaterThanOrEqual(86);
    expect((FOCUS.y + CLEAR.y) * 1200).toBeLessThanOrEqual(1114);
    // the drawing is punched in the ground, since there is no panel under it
    const svg = bannerSvg({ seed: "a-post", treatment: "graph" });
    expect(svg).toContain(`fill="${INK.ground}"`);
  });

  it("draws every treatment, and a different picture for each", () => {
    const seen = new Set();
    for (const treatment of TREATMENTS) {
      const svg = bannerSvg({ seed: "a", treatment });
      expect(svg).toContain('<g fill="none"');
      expect(SUBJECTS[treatment]).toEqual(expect.any(String));
      seen.add(svg);
    }
    expect(seen.size).toBe(TREATMENTS.length);
  });

  it("is deterministic and varies by seed", () => {
    expect(bannerSvg({ seed: "a" })).toBe(bannerSvg({ seed: "a" }));
    expect(bannerSvg({ seed: "a" })).not.toBe(bannerSvg({ seed: "b" }));
  });
});

describe("ogSvg", () => {
  const card = {
    seed: "what-an-ontology-buys-an-agent",
    title: "What an Ontology Buys an Agent",
    summary: "Agents fail confidently when they answer from the wrong context.",
    kind: "Research · Ontologies",
    meta: ["September 9, 2026", "7 min read"],
  };

  it("sets the eyebrow, title, summary, wordmark and meta as outlines on ink", () => {
    const svg = ogSvg(card);
    expect(svg).toMatch(/width="1200" height="630"/);
    expect(svg).toContain(
      `<rect width="1200" height="630" fill="${INK.ground}"/>`,
    );
    expect(svg).not.toContain("<text");
    expect(svg).toContain('viewBox="0 0 453.868 93.246"');
    // the eyebrow's dash and text, the panel's dot, and the wordmark's x
    expect(gold(svg)).toBe(4);
    expect(svg).toContain(
      `<rect x="72" y="105" width="20" height="2" fill="${INK.gold}"/>`,
    );
    expect(svg).toContain(`fill="${INK.text}"`);
    expect(svg).toContain(`fill="${INK.muted}"`);
    expect(svg).toContain('<line x1="72" y1="542" x2="1128" y2="542"');
    expect(svg).not.toMatch(/gradient/i);
  });

  it("keeps the lattice off the text column", () => {
    const svg = ogSvg(card);
    const cells = [...svg.matchAll(/<polygon points="(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(cells.length).toBeGreaterThan(50);
    // a cell may start one cell-width left of the lattice box, no further
    expect(Math.min(...cells)).toBeGreaterThanOrEqual(740 - 28);
  });

  it("wraps a long title, stepping the size down before it ellipsises", () => {
    const short = ogSvg(card);
    const long = ogSvg({
      ...card,
      title:
        "Deterministic Coding Agents: Every Turn on the Record, Replayable, and Auditable by a Colleague Who Was Not There",
    });
    expect(short).toContain("scale(0.06000 -0.06000)");
    expect(long).not.toContain("scale(0.06000 -0.06000)");
    expect(long).toContain("scale(0.04800 -0.04800)");
    expect(long.length).toBeGreaterThan(short.length);
  });

  it("works without meta and with an explicit treatment", () => {
    const svg = ogSvg({ ...card, meta: undefined, treatment: "ledger" });
    expect(svg).toContain('<g fill="none"');
    expect(gold(svg)).toBe(4);
  });
});
