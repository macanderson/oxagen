import { describe, expect, it } from "vitest";
import { coverSvg } from "./cover-art.mjs";

const PILLARS = [
  "ontologies",
  "ai-agents",
  "coding-agents",
  "self-improving-models",
  "self-evolving-agents",
];

const SLUGS = [
  "what-an-ontology-buys-an-agent",
  "deterministic-coding-agents-every-turn-on-the-record",
  "self-evolving-agents-what-the-evidence-shows",
  "governing-an-agent-that-rewrites-itself",
  "why-agents-fail-measuring-reliability-and-cost",
];

function goldCount(svg) {
  return (svg.match(/fill="#D6962C"/g) ?? []).length;
}

describe("coverSvg", () => {
  it("is a well-formed 1600x900 SVG on the ink ground", () => {
    const svg = coverSvg({
      slug: "what-an-ontology-buys-an-agent",
      pillar: "ontologies",
    });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('width="1600" height="900"');
    expect(svg).toContain('viewBox="0 0 1600 900"');
    expect(svg).toContain('<rect width="1600" height="900" fill="#10100F"/>');
    expect(svg.trim().endsWith("</svg>")).toBe(true);
  });

  it("is deterministic: the same slug always renders the same cover", () => {
    const a = coverSvg({
      slug: "what-an-ontology-buys-an-agent",
      pillar: "ontologies",
    });
    const b = coverSvg({
      slug: "what-an-ontology-buys-an-agent",
      pillar: "ontologies",
    });
    expect(a).toBe(b);
  });

  it("gives different posts different covers", () => {
    const a = coverSvg({
      slug: "what-an-ontology-buys-an-agent",
      pillar: "ontologies",
    });
    const b = coverSvg({
      slug: "why-agents-fail-measuring-reliability-and-cost",
      pillar: "ai-agents",
    });
    expect(a).not.toBe(b);
  });

  it("uses gold exactly once, across every pillar and post", () => {
    for (const pillar of PILLARS) {
      for (const slug of SLUGS) {
        const svg = coverSvg({ slug: `${slug}-${pillar}`, pillar });
        expect(goldCount(svg)).toBe(1);
      }
    }
  });

  it("falls back to a default personality for an unlisted pillar", () => {
    const svg = coverSvg({ slug: "a-future-post", pillar: "some-new-pillar" });
    expect(goldCount(svg)).toBe(1);
    expect(svg).toContain('viewBox="0 0 1600 900"');
  });

  it("never draws a shape outside the flat house-brand tones", () => {
    const svg = coverSvg({
      slug: "what-an-ontology-buys-an-agent",
      pillar: "ontologies",
    });
    const fills = [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6}|none)"/g)].map(
      (m) => m[1],
    );
    const allowed = new Set([
      "#10100F",
      "#181715",
      "#201F1C",
      "#D6962C",
      "none",
    ]);
    for (const fill of fills) expect(allowed.has(fill)).toBe(true);
    const strokes = [...svg.matchAll(/stroke="(#[0-9A-Fa-f]{6})"/g)].map(
      (m) => m[1],
    );
    const allowedStroke = new Set(["#292722", "#34322D", "#504C44"]);
    for (const stroke of strokes) expect(allowedStroke.has(stroke)).toBe(true);
  });

  it("contains no gradients (the brand forbids them)", () => {
    const svg = coverSvg({
      slug: "what-an-ontology-buys-an-agent",
      pillar: "self-evolving-agents",
    });
    expect(svg).not.toMatch(/gradient/i);
  });
});
