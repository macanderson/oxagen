// The images the build generates: a post's banner and thumbnail, and the
// Open Graph card for every page. Each is a pure function of its inputs and
// theme, built from art.mjs (honeycomb and the seven drawings) and text.mjs
// (Space Grotesk as outlines), and rendered by raster.mjs.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drawing, hash32, honeycomb, prng, treatmentFor } from "./art.mjs";
import { textPath, wrap } from "./text.mjs";
import { theme } from "./theme.mjs";

export const BANNER = { w: 1600, h: 900 };
export const THUMB = { w: 800, h: 450 };
export const OG = { w: 1200, h: 630 };

const WORDMARK_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/brand/oxagen-wordmark-on-dark.svg",
);
let wordmarkPaths = null;

/**
 * The oxagen wordmark as a nested <svg>, letters in the theme's text colour
 * and the x in the metal, `height` px tall with its left edge at (x, y).
 */
export function wordmark(t, { x, y, height }) {
  wordmarkPaths ??= readFileSync(WORDMARK_FILE, "utf8")
    .replace(/^[\s\S]*?<path/, "<path")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<style>[\s\S]*?<\/style>/, "");
  const paths = wordmarkPaths.replace('fill="#F2EEE5"', `fill="${t.text}"`);
  const width = (height * 453.868) / 93.246;
  return `<svg x="${x}" y="${y}" width="${width.toFixed(1)}" height="${height}" viewBox="0 0 453.868 93.246">${paths}</svg>`;
}

/** @param {number} w @param {number} h @param {object} t @param {string} body */
function document(w, h, t, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${t.ground}"/>
${body}
</svg>
`;
}

/**
 * A post's banner: the honeycomb on one side, one of the seven drawings on
 * the other. The thumbnail is this same picture rendered at half size.
 * @param {{ seed: string, theme: "dark"|"light", treatment?: string }} o
 */
export function bannerSvg(o) {
  const t = theme(o.theme);
  const { w, h } = BANNER;
  const rand = prng(hash32(`banner:${o.seed}`));
  const treatment = o.treatment ?? treatmentFor(o.seed);
  const flip = rand() < 0.5;
  const cell = 44 + rand() * 20;
  const combBox = { x: flip ? w * 0.38 : 0, y: 0, w: w * 0.62, h };
  const drawBox = {
    x: flip ? w * 0.06 : w * 0.48,
    y: h * 0.1,
    w: w * 0.46,
    h: h * 0.8,
  };
  return document(
    w,
    h,
    t,
    honeycomb({
      rand,
      t,
      ...combBox,
      cell,
      density: 0.42,
      tilt: (rand() - 0.5) * 10,
    }) + drawing(treatment, { rand, t, ...drawBox }),
  );
}

/**
 * The Open Graph card for a page or post: eyebrow, title, summary, the
 * wordmark, and a meta line, with a drawing and a little honeycomb on the
 * right. 1200×630, the size every network renders without cropping.
 * @param {{ seed: string, theme: "dark"|"light", title: string, summary: string,
 *   kind: string, meta?: string[], treatment?: string }} o
 */
export function ogSvg(o) {
  const t = theme(o.theme);
  const { w, h } = OG;
  const rand = prng(hash32(`og:${o.seed}`));
  const treatment = o.treatment ?? treatmentFor(o.seed);
  const left = 72;
  const right = w - 72;
  const column = 660;
  const parts = [];

  parts.push(
    honeycomb({
      rand,
      t,
      x: w * 0.62,
      y: 0,
      w: w * 0.38,
      h: h - 110,
      cell: 30,
      density: 0.3,
      tilt: (rand() - 0.5) * 8,
    }),
  );
  parts.push(
    drawing(treatment, { rand, t, x: w * 0.64, y: 70, w: w * 0.31, h: 400 }),
  );
  // the drawing sits behind the text column's right edge on a wide title, so
  // the column keeps a solid ground under it
  parts.push(
    `<rect x="0" y="0" width="${left + column + 24}" height="${h}" fill="${t.ground}"/>`,
  );

  parts.push(
    textPath(o.kind.toUpperCase(), {
      x: left,
      y: 112,
      size: 19,
      weight: 500,
      tracking: 0.14,
      fill: t.muted,
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
    parts.push(textPath(text, { x: left, y, size, weight: 600, fill: t.text }));
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
    parts.push(textPath(text, { x: left, y, size: 24, fill: t.body }));
    y += 24 * 1.4;
  }

  const ruleY = h - 88;
  parts.push(
    `<line x1="${left}" y1="${ruleY}" x2="${right}" y2="${ruleY}" stroke="${t.line}" stroke-width="1.5"/>`,
  );
  parts.push(wordmark(t, { x: left, y: ruleY + 26, height: 32 }));
  const meta = ["oxagen.sh", ...(o.meta ?? [])].join("   ·   ");
  parts.push(
    textPath(meta, {
      x: right,
      y: ruleY + 50,
      size: 20,
      weight: 500,
      fill: t.muted,
      anchor: "end",
    }),
  );

  return document(w, h, t, parts.join("\n"));
}
