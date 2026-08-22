#!/usr/bin/env node
/**
 * Regenerate the PWA splash spinner GIFs from the Oxagen mark.
 *
 *   node tools/scripts/gen-spinner-gifs.mjs
 *
 * The GIFs in apps/app/public/spinner/ are generated, not hand-drawn, so that
 * the spinner can never drift away from the logomark: the path data and the
 * viewBox below are copied verbatim from
 * docs/brand/logos/svg/oxagen-glyph-adaptive.svg, which is the same geometry
 * packages/ui/src/components/brand.tsx renders.
 *
 * The animation is the brand spinner's own mechanic (docs/brand/spinner/)
 * reduced to a single glyph: a terminal cursor blinks in an empty slot, the
 * "o" is typed, the cursor advances to its place beside it, then blinks.
 *
 * Frames are rendered on the SOLID background the splash paints
 * (pwa-splash.module.css) rather than on transparency — 1-bit GIF alpha
 * fringes badly around the round counter of the "o", and the splash background
 * is a known colour, so a matte is both cleaner and smaller.
 *
 * Requires `rsvg-convert` (librsvg) and `ffmpeg` on PATH.
 */

import { writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(REPO, "apps", "app", "public", "spinner");

/** The "o" letterform — oxagen-glyph-adaptive.svg, unchanged. */
const O_PATH =
  "M30 1.2Q22.4 1.2 16.7 -2.25Q11 -5.7 7.8 -12Q4.6 -18.3 4.6 -26.8Q4.6 -35.4 7.8 -41.65Q11 -47.9 16.7 -51.35Q22.4 -54.8 30 -54.8Q37.6 -54.8 43.3 -51.35Q49 -47.9 52.2 -41.65Q55.4 -35.4 55.4 -26.8Q55.4 -18.3 52.2 -12Q49 -5.7 43.3 -2.25Q37.6 1.2 30 1.2ZM30 -10.8Q35.4 -10.8 38.35 -14.95Q41.3 -19.1 41.3 -26.8Q41.3 -34.6 38.35 -38.7Q35.4 -42.8 30 -42.8Q24.6 -42.8 21.65 -38.7Q18.7 -34.6 18.7 -26.8Q18.7 -19.1 21.65 -14.95Q24.6 -10.8 30 -10.8Z";

const SIZE = 128; // 2x the 64px the splash renders, for retina
const PAD = 10;
const MARK = { w: 143.4, h: 90.2, x: -4.4, y: -80 }; // the mark's own viewBox
const CURSOR = { x: 74, y: -71, w: 56, h: 71, r: 3.4 };
const CURSOR_SLOT_X = 2; // where the cursor waits before the "o" is typed

const SCALE = (SIZE - PAD * 2) / MARK.w;
const TX = PAD - MARK.x * SCALE;
const TY = (SIZE - MARK.h * SCALE) / 2 - MARK.y * SCALE;

/** [oVisible, cursorX, cursorVisible] — 16 frames at 10fps = a 1.6s loop. */
const FRAMES = [
  [0, CURSOR_SLOT_X, 1],
  [0, CURSOR_SLOT_X, 0],
  [0, CURSOR_SLOT_X, 1],
  [0, CURSOR_SLOT_X, 0],
  [1, CURSOR.x, 1],
  [1, CURSOR.x, 1],
  [1, CURSOR.x, 0],
  [1, CURSOR.x, 0],
  [1, CURSOR.x, 1],
  [1, CURSOR.x, 1],
  [1, CURSOR.x, 0],
  [1, CURSOR.x, 0],
  [1, CURSOR.x, 1],
  [1, CURSOR.x, 1],
  [1, CURSOR.x, 0],
  [1, CURSOR.x, 0],
];

/** Backgrounds match .splash in apps/app/src/components/pwa/pwa-splash.module.css. */
const VARIANTS = {
  dark: { bg: "#0B0B0C", ink: "#F5F6F7", cursor: "#FF4B2A" },
  light: { bg: "#FAFAFA", ink: "#0B0B0C", cursor: "#FF3D1F" },
};

function frameSvg({ bg, ink, cursor }, [oVisible, cursorX, cursorVisible]) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>` +
    `<g transform="translate(${TX.toFixed(3)},${TY.toFixed(3)}) scale(${SCALE.toFixed(5)})">` +
    (oVisible ? `<path d="${O_PATH}" fill="${ink}"/>` : "") +
    (cursorVisible
      ? `<rect x="${cursorX}" y="${CURSOR.y}" width="${CURSOR.w}" height="${CURSOR.h}" rx="${CURSOR.r}" fill="${cursor}"/>`
      : "") +
    `</g></svg>`
  );
}

const work = join(tmpdir(), `oxagen-spinner-${process.pid}`);
try {
  for (const [name, variant] of Object.entries(VARIANTS)) {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    FRAMES.forEach((frame, i) => {
      const n = String(i).padStart(2, "0");
      writeFileSync(join(dir, `f${n}.svg`), frameSvg(variant, frame));
      execFileSync("rsvg-convert", [
        "-w",
        String(SIZE),
        "-h",
        String(SIZE),
        join(dir, `f${n}.svg`),
        "-o",
        join(dir, `f${n}.png`),
      ]);
    });
    const gif = join(work, `${name}.gif`);
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "10",
      "-i",
      join(dir, "f%02d.png"),
      "-filter_complex",
      "[0:v]split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse",
      gif,
    ]);
    const dest = join(OUT, `oxagen-spinner-assemble-${name}.gif`);
    copyFileSync(gif, dest);
    console.log(`${name}: ${FRAMES.length} frames -> ${dest}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
