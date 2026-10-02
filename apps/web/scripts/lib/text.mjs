// Text for generated images, set as glyph outlines rather than <text>, so the
// raster never depends on which fonts a machine has installed. Aeonik is
// the house face for text. Space Grotesk sets the wordmark only, and the card
// draws the wordmark from its SVG. A weight is instanced from the variable file on
// demand, the same way the kit's glyphs.py does it.
//
// The outlines come from scripts/fonts/aeonik-wght.ttf, the kit's
// fonts/aeonik-wght.woff2 unpacked to a TTF the way glyphs.py unpacks it.
// fontkit 2.0.4 can't instance a weight from the WOFF2 itself: getVariation
// reads the file again as a plain TrueType font, which finds no cmap, and
// fontkit never applies a weight to the outlines it decodes from a WOFF2.
// When the brand sync changes the site's WOFF2, unpack it again with
// `node apps/web/scripts/unpack-aeonik.mjs`. Until someone does,
// `pnpm check:contracts` fails (lib/aeonik-ttf.mjs).

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

const FONT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fonts/aeonik-wght.ttf",
);

let base = null;
const instances = new Map();

/** @param {number} weight */
function font(weight) {
  base ??= fontkit.openSync(FONT_FILE);
  let f = instances.get(weight);
  if (!f) {
    f = base.getVariation({ wght: weight });
    instances.set(weight, f);
  }
  return f;
}

/**
 * @param {string} text
 * @param {{ size: number, weight?: number, tracking?: number }} o tracking in em
 */
export function measure(text, { size, weight = 400, tracking = 0 }) {
  const f = font(weight);
  const run = f.layout(text);
  return (run.advanceWidth / f.unitsPerEm + tracking * text.length) * size;
}

/**
 * Greedy word wrap to `maxWidth`, at most `maxLines` lines; the last line is
 * ellipsised when the text does not fit. A single word longer than a line is
 * broken by character.
 * @param {string} text
 * @param {{ size: number, weight?: number, tracking?: number, maxWidth: number, maxLines: number }} o
 */
export function wrap(text, o) {
  const fits = (s) => measure(s, o) <= o.maxWidth;
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => breakWord(w, fits));
  const lines = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (fits(next) || !line) {
      line = next;
      continue;
    }
    if (lines.length === o.maxLines - 1) {
      lines.push(ellipsise([line, ...words.slice(i)].join(" "), o));
      return lines;
    }
    lines.push(line);
    line = words[i];
  }
  if (line) lines.push(line);
  return lines;
}

/** A word wider than the line, split with hyphens so each piece fits. */
function breakWord(word, fits) {
  const parts = [];
  let rest = word;
  while (!fits(rest)) {
    let cut = rest.length - 1;
    while (cut > 1 && !fits(`${rest.slice(0, cut)}-`)) cut--;
    parts.push(`${rest.slice(0, cut)}-`);
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

function ellipsise(s, o) {
  let out = s.trim();
  while (out && measure(`${out}…`, o) > o.maxWidth) {
    out = out.replace(/\s*\S+$/, "");
  }
  return `${out}…`;
}

/**
 * An SVG fragment drawing `text` as filled outlines with its baseline at
 * (x, y). `anchor` "end" right-aligns on x.
 * @param {string} text
 * @param {{ x: number, y: number, size: number, weight?: number, fill: string, tracking?: number, anchor?: "start"|"end" }} o
 */
export function textPath(text, o) {
  const weight = o.weight ?? 400;
  const f = font(weight);
  const run = f.layout(text);
  const s = o.size / f.unitsPerEm;
  const tracking = (o.tracking ?? 0) * f.unitsPerEm;
  const width = measure(text, {
    size: o.size,
    weight,
    tracking: o.tracking ?? 0,
  });
  const x0 = o.anchor === "end" ? o.x - width : o.x;
  let pen = 0;
  const glyphs = [];
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    const d = g.path.toSVG();
    if (d) {
      glyphs.push(
        `<path d="${d}" transform="translate(${(pen + pos.xOffset).toFixed(1)} ${pos.yOffset})"/>`,
      );
    }
    pen += pos.xAdvance + tracking;
  });
  return `<g fill="${o.fill}" transform="translate(${x0.toFixed(1)} ${o.y}) scale(${s.toFixed(5)} ${(-s).toFixed(5)})">${glyphs.join("")}</g>`;
}
