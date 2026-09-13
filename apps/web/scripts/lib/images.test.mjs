import { describe, expect, it } from "vitest";
import { TREATMENTS } from "./art.mjs";
import { BANNER, bannerSvg, OG, ogSvg, THUMB, wordmark } from "./images.mjs";
import { theme, THEMES } from "./theme.mjs";

const gold = (svg) => (svg.match(/fill="#D6962C"/g) ?? []).length;

describe("sizes", () => {
  it("are the ones the site and the networks expect", () => {
    expect(BANNER).toEqual({ w: 1600, h: 900 });
    expect(THUMB).toEqual({ w: 800, h: 450 });
    expect(OG).toEqual({ w: 1200, h: 630 });
  });
});

describe("wordmark", () => {
  it("nests the brand file, letters in the theme's text colour and the x in gold", () => {
    const dark = wordmark(theme("dark"), { x: 10, y: 20, height: 30 });
    expect(dark).toMatch(
      /^<svg x="10" y="20" width="146\.0" height="30" viewBox="0 0 453\.868 93\.246">/,
    );
    expect(dark).toContain('fill="#F2EEE5"');
    expect(dark).toContain('fill="#D6962C"');
    expect(dark).not.toContain("<style");
    const light = wordmark(theme("light"), { x: 0, y: 0, height: 30 });
    expect(light).toContain('fill="#10100F"');
    expect(light).not.toContain('fill="#F2EEE5"');
  });
});

describe("bannerSvg", () => {
  it("is a full-size document on the theme's ground with one gold cell and a drawing", () => {
    for (const th of THEMES) {
      const svg = bannerSvg({ seed: "a-post", theme: th });
      expect(svg).toMatch(
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1600" height="900"/,
      );
      expect(svg).toContain(`fill="${theme(th).ground}"`);
      expect(gold(svg)).toBe(1);
      expect(svg).toContain('<g fill="none" stroke=');
      expect(svg).not.toMatch(/gradient|<text/i);
    }
  });

  it("is deterministic, varies by seed, and honours an explicit treatment", () => {
    expect(bannerSvg({ seed: "a", theme: "dark" })).toBe(
      bannerSvg({ seed: "a", theme: "dark" }),
    );
    expect(bannerSvg({ seed: "a", theme: "dark" })).not.toBe(
      bannerSvg({ seed: "b", theme: "dark" }),
    );
    for (const treatment of TREATMENTS) {
      expect(bannerSvg({ seed: "a", theme: "dark", treatment })).toContain(
        '<g fill="none"',
      );
    }
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

  it("sets the title, summary, eyebrow, wordmark and meta as outlines in both themes", () => {
    for (const th of THEMES) {
      const svg = ogSvg({ ...card, theme: th });
      expect(svg).toMatch(/width="1200" height="630"/);
      expect(svg).not.toContain("<text");
      expect(svg).toContain('viewBox="0 0 453.868 93.246"');
      expect(gold(svg)).toBe(2); // the one cell, and the wordmark's x
      expect(svg).toContain(`fill="${theme(th).text}"`);
      expect(svg).toContain(`fill="${theme(th).muted}"`);
      expect(svg).toContain('<line x1="72" y1="542" x2="1128" y2="542"');
    }
  });

  it("wraps a long title, stepping the size down before it ellipsises", () => {
    const short = ogSvg({ ...card, theme: "dark" });
    const long = ogSvg({
      ...card,
      theme: "dark",
      title:
        "Deterministic Coding Agents: Every Turn on the Record, Replayable, and Auditable by a Colleague Who Was Not There",
    });
    expect(short).toContain("scale(0.06000 -0.06000)");
    expect(long).not.toContain("scale(0.06000 -0.06000)");
    expect(long).toContain("scale(0.04800 -0.04800)");
    expect(long.length).toBeGreaterThan(short.length);
  });

  it("works without meta and with an explicit treatment", () => {
    const svg = ogSvg({
      ...card,
      theme: "light",
      meta: undefined,
      treatment: "ledger",
    });
    expect(svg).toContain('<g fill="none"');
    expect(gold(svg)).toBe(2);
  });
});
