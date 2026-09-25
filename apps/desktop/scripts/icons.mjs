#!/usr/bin/env node
/**
 * Generate the desktop app icon set from a house-brand square, vendored by
 * tools/scripts/sync-brand-assets.mjs so this never needs the kit checked out.
 *
 *   node scripts/icons.mjs [variant] [--maskable-only] [--list]
 *
 * The variant names a face and a ground: `avatar-light` (the default, and what
 * the shipped app wears), `avatar-dark`, `tile-light`, `tile-dark`.
 *
 * WHY THE AVATAR AND NOT THE TILE. The tile is a favicon shape — a rounded
 * plate carrying the `Ox`, drawn to stay legible at 16px in a browser tab. A
 * dock icon is none of those things: it is large, it sits against the user's
 * own wallpaper, and macOS and Windows both round it themselves, so a second
 * set of corners inside the system's reads as a double border. The avatar is
 * the hive full-bleed on its ground, which is the face the brand wears
 * wherever the image IS the brand rather than a mark inside a page.
 *
 * LIGHT IS THE DEFAULT. A desktop icon cannot adapt — one raster ships and is
 * shown against whatever the user has behind it — so the choice is made once,
 * here, and the cream ground is the face Oxagen leads with. Both grounds are
 * legible (the kit draws the hive in house black on cream, and in cream on
 * house black), so this is a brand decision rather than a legibility one;
 * `avatar-dark` is cut from the same source for anyone who wants it.
 *
 * Rasterises with rsvg-convert (`brew install librsvg`) at 1024px, then lets
 * `tauri icon` emit the .icns, .ico and PNG sizes into src-tauri/icons. The
 * generated icons are committed so a CI runner needs no librsvg.
 *
 * Maskable icons are emitted alongside: full bleed, the hive pulled into the
 * 80% safe circle a round mask keeps. Tauri does not consume them — they are
 * for the surfaces that ask for one (an Android/PWA wrapper, a Linux adaptive
 * theme), and cutting them from the same source is what stops that surface
 * drifting onto a different mark.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const repo = resolve(app, "..", "..");
const brand = join(repo, "apps/app/public/brand");

/**
 * The faces this generator can cut, and how much of the square each may
 * occupy inside a maskable icon's safe circle. The hive spans ~63% of its
 * canvas and sits near-centred, so 0.80 clears the circle; the `Ox` tile keeps
 * the 0.72 the web maskables have always used.
 */
const VARIANTS = {
  "avatar-light": { file: "oxagen-avatar-light.svg", maskableScale: 0.8 },
  "avatar-dark": { file: "oxagen-avatar-dark.svg", maskableScale: 0.8 },
  "tile-light": { file: "oxagen-icon-tile-light.svg", maskableScale: 0.72 },
  "tile-dark": { file: "oxagen-icon-tile-dark.svg", maskableScale: 0.72 },
};

/** What the app ships. See the header for why it is the light avatar. */
const DEFAULT_VARIANT = "avatar-light";

/** The sizes a maskable is asked for, matching the web manifest's pair. */
const MASKABLE_SIZES = [192, 512];

const argv = process.argv.slice(2);
if (argv.includes("--list")) {
  console.log(Object.keys(VARIANTS).join("\n"));
  process.exit(0);
}
const maskableOnly = argv.includes("--maskable-only");
const requested = argv.find((arg) => !arg.startsWith("--")) ?? DEFAULT_VARIANT;
const variant = VARIANTS[requested];
if (!variant) {
  console.error(
    `✖ unknown icon variant "${requested}"; expected one of ${Object.keys(VARIANTS).join(", ")}`,
  );
  process.exit(1);
}

const source = join(brand, variant.file);
const work = join(app, "src-tauri", "icons");
mkdirSync(work, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: app });
  if (result.status !== 0) {
    console.error(`✖ ${command} ${args.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/**
 * The source cut for a round mask: rounded corners off, and the mark — the
 * first `<g transform=`, which is the hive's placement group in an avatar and
 * the glyph's in a tile — inset to the safe circle. The ground is deliberately
 * left at full size so its wash stays continuous to the edge; shrinking the
 * whole square leaves a visible rounded seam where the wash stops. Mirrors
 * `maskableSvg` in tools/scripts/sync-brand-assets.mjs.
 */
function maskableSvg(sourceSvgPath, scale) {
  const src = readFileSync(sourceSvgPath, "utf8");
  const size = Number(src.match(/<svg\b[^>]*?\bwidth="([\d.]+)"/)?.[1]);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`no usable width on the <svg> in ${sourceSvgPath}`);
  }
  const inset = (size * (1 - scale)) / 2;
  const out = src
    .replace(
      new RegExp(`(<rect width="${size}" height="${size}")\\s+rx="[\\d.]+"`),
      "$1",
    )
    .replace(
      /<g transform=/,
      `<g transform="translate(${inset} ${inset}) scale(${scale})"><g transform=`,
    )
    .replace(/<\/g>(\s*)<\/svg>\s*$/, "</g></g>$1</svg>");
  if (out === src) {
    throw new Error(`no mark group to inset in ${sourceSvgPath}`);
  }
  return out;
}

// Intermediates go to a scratch directory: only the icons themselves are
// committed, so a rebuild never leaves a 1024px source or a wrapper SVG behind
// to be reviewed as if it were an asset.
const scratch = mkdtempSync(join(tmpdir(), "oxagen-icons-"));
// `run` exits on the first command that fails, and `maskableSvg` throws on a
// source it cannot cut. Both leave through the exit event, so neither strands
// the scratch directory.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

if (!maskableOnly) {
  const png = join(scratch, "source-1024.png");
  run("rsvg-convert", ["-w", "1024", "-h", "1024", "-o", png, source]);
  run("pnpm", ["exec", "tauri", "icon", png, "--output", work]);
  // `tauri icon` always writes the mobile sets too. This app is desktop only
  // (there is no src-tauri/gen/apple or /android), so they would be committed
  // bytes no build ever reads — drop them rather than gitignore them, so a
  // future mobile target gets them by regenerating rather than by hunting an
  // ignore rule.
  for (const mobile of ["android", "ios"]) {
    rmSync(join(work, mobile), { recursive: true, force: true });
  }
}

// Maskable pair, off the same source, for the surfaces that ask for one.
const maskSvg = join(scratch, `maskable-${requested}.svg`);
writeFileSync(maskSvg, maskableSvg(source, variant.maskableScale));
for (const size of MASKABLE_SIZES) {
  run("rsvg-convert", [
    "-w",
    String(size),
    "-h",
    String(size),
    "-o",
    join(work, `maskable-${size}.png`),
    maskSvg,
  ]);
}
console.log(`✔ ${requested} icons in ${work}`);
