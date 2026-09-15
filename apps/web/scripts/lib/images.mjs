// The images the build generates: a post's banner and thumbnail, and the
// Open Graph card for every page. Each is a pure function of its inputs,
// built from art.mjs (the field, the halo, the panel and the seven drawings) and
// text.mjs (Space Grotesk as outlines), and rendered by raster.mjs. Every
// image is on ink: the site is ink, and an ink image reads on any ground.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  drawing,
  field,
  halo,
  hash32,
  lattice,
  panel,
  prng,
  SUBJECTS,
  treatmentFor,
} from "./art.mjs";
import { textPath, wrap } from "./text.mjs";
import { INK } from "./theme.mjs";

export const BANNER = { w: 2400, h: 1200 };
export const THUMB = { w: 960, h: 480 };

/**
 * Where a banner's drawing sits, as fractions of the banner: right of
 * centre, so a page can set its title over the quiet left and let the
 * picture come through on the right. The clearing is the drawing's box.
 */
export const FOCUS = { x: 0.7, y: 0.5 };
export const CLEAR = { x: 0.26, y: 0.34 };
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
 * A post's banner: a full-bleed field on ink. The honeycomb weathers across
 * the whole picture, quiet on the left and clustered on the right; halo
 * rings step out from a focus right of centre, and the post's drawing sits
 * in the clearing at the focus. A page lays this behind its title, so the
 * left is kept for words and the drawing keeps within the middle 21:9 band
 * a wide hero crops to. The thumbnail is this same picture at two fifths
 * the size.
 * @param {{ seed: string, treatment?: string }} o
 */
export function bannerSvg(o) {
  const { w, h } = BANNER;
  const rand = prng(hash32(`banner:${o.seed}`));
  const treatment = o.treatment ?? treatmentFor(o.seed);
  const focus = { x: w * FOCUS.x, y: h * FOCUS.y };
  const clear = { x: w * CLEAR.x, y: h * CLEAR.y };
  return document(
    w,
    h,
    field({ rand, x: 0, y: 0, w, h, cell: w / 64, focus, clear }) +
      halo({ focus, clear }) +
      drawing(treatment, {
        rand,
        x: focus.x - clear.x,
        y: focus.y - clear.y,
        w: clear.x * 2,
        h: clear.y * 2,
        surface: INK.ground,
      }),
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
