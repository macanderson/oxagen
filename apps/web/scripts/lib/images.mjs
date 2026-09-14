// The images the build generates: a post's banner and thumbnail, and the
// Open Graph card for every page. Each is a pure function of its inputs,
// built from art.mjs (the lattice, the panel and the seven drawings) and
// text.mjs (Space Grotesk as outlines), and rendered by raster.mjs. Every
// image is on ink: the site is ink, and an ink image reads on any ground.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  drawing,
  hash32,
  lattice,
  panel,
  prng,
  SUBJECTS,
  treatmentFor,
} from "./art.mjs";
import { textPath, wrap } from "./text.mjs";
import { INK } from "./theme.mjs";

export const BANNER = { w: 1600, h: 900 };
export const THUMB = { w: 800, h: 450 };
export const OG = { w: 1200, h: 630 };

const WORDMARK_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/brand/oxagen-wordmark-on-dark.svg",
);
let wordmarkPaths = null;

/**
 * The oxagen wordmark as a nested <svg>, letters in the text tone and the x
 * in gold, `height` px tall with its left edge at (x, y).
 */
export function wordmark({ x, y, height }) {
  wordmarkPaths ??= readFileSync(WORDMARK_FILE, "utf8")
    .replace(/^[\s\S]*?<path/, "<path")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<style>[\s\S]*?<\/style>/, "");
  const width = (height * 453.868) / 93.246;
  return `<svg x="${x}" y="${y}" width="${width.toFixed(1)}" height="${height}" viewBox="0 0 453.868 93.246">${wordmarkPaths}</svg>`;
}

/** @param {number} w @param {number} h @param {string} body */
function document(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${INK.ground}"/>
${body}
</svg>
`;
}

/**
 * A post's banner: the lattice across the ink, and one panel holding the
 * post's drawing. The panel is centred, so the post hero's 21:9 crop keeps
 * all of it and the pillar hero's 380px band keeps its middle: a panel cut
 * at the top and bottom still reads as a panel. The thumbnail is this same
 * picture rendered at half size.
 * @param {{ seed: string, treatment?: string }} o
 */
export function bannerSvg(o) {
  const { w, h } = BANNER;
  const rand = prng(hash32(`banner:${o.seed}`));
  const treatment = o.treatment ?? treatmentFor(o.seed);
  const card = panel({
    x: 260,
    y: 170,
    w: w - 520,
    h: 560,
    label: `oxagen — ${SUBJECTS[treatment]}`,
    pad: 56,
  });
  return document(
    w,
    h,
    lattice({ x: 0, y: 0, w, h, cell: 34 }) +
      card.svg +
      drawing(treatment, { rand, ...card.box }),
  );
}

/**
 * The Open Graph card for a page or post: eyebrow, title, summary, the
 * wordmark, and a meta line, with a panel holding the drawing on the right.
 * 1200×630, the size every network renders without cropping.
 * @param {{ seed: string, title: string, summary: string, kind: string,
 *   meta?: string[], treatment?: string }} o
 */
export function ogSvg(o) {
  const { w, h } = OG;
  const rand = prng(hash32(`og:${o.seed}`));
  const treatment = o.treatment ?? treatmentFor(o.seed);
  const left = 72;
  const right = w - 72;
  const column = 640;
  const parts = [];

  // the lattice sits behind the panel only, fading out before it reaches
  // the text column, so a wide title never crosses it
  parts.push(lattice({ x: 740, y: 0, w: w - 740, h: h - 100, cell: 28 }));
  const card = panel({
    x: 776,
    y: 72,
    w: right - 776,
    h: 400,
    label: SUBJECTS[treatment],
    pad: 32,
  });
  parts.push(card.svg, drawing(treatment, { rand, ...card.box }));

  // the eyebrow the site uses: a gold dash, then the kind in gold, tracked
  parts.push(
    `<rect x="${left}" y="${105}" width="20" height="2" fill="${INK.gold}"/>`,
  );
  parts.push(
    textPath(o.kind.toUpperCase(), {
      x: left + 32,
      y: 112,
      size: 17,
      weight: 500,
      tracking: 0.2,
      fill: INK.gold,
    }),
  );

  let size = 60;
  let lines;
  for (const candidate of [60, 54, 48]) {
    size = candidate;
    lines = wrap(o.title, {
      size,
      weight: 600,
      maxWidth: column,
      maxLines: 3,
    });
    if (!lines.at(-1).endsWith("…")) break;
  }
  let y = 150 + size;
  for (const text of lines) {
    parts.push(
      textPath(text, { x: left, y, size, weight: 600, fill: INK.text }),
    );
    y += size * 1.12;
  }

  const summaryLines = wrap(o.summary, {
    size: 24,
    weight: 400,
    maxWidth: column,
    maxLines: 3,
  });
  y += 24;
  for (const text of summaryLines) {
    parts.push(textPath(text, { x: left, y, size: 24, fill: INK.body }));
    y += 24 * 1.4;
  }

  const ruleY = h - 88;
  parts.push(
    `<line x1="${left}" y1="${ruleY}" x2="${right}" y2="${ruleY}" stroke="${INK.line}" stroke-width="1.5"/>`,
  );
  parts.push(wordmark({ x: left, y: ruleY + 26, height: 32 }));
  const meta = ["oxagen.sh", ...(o.meta ?? [])].join("   ·   ");
  parts.push(
    textPath(meta, {
      x: right,
      y: ruleY + 50,
      size: 20,
      weight: 500,
      fill: INK.muted,
      anchor: "end",
    }),
  );

  return document(w, h, parts.join("\n"));
}
