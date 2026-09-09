#!/usr/bin/env node
/**
 * Pull the Oxagen house brand system into every frontend in this repo.
 *
 * The house kit (macanderson/oxagen-house-brand) generates every mark, icon,
 * social card and spinner from `build/`. Nothing in it is drawn by hand, so
 * nothing here is copied by hand either: this script is the one seam between
 * the kit and the apps, and re-running it after a kit rebuild re-flows the
 * whole product.
 *
 *   node tools/scripts/sync-brand-assets.mjs [--brand <dir>] [--check]
 *
 * --brand   where the kit is checked out. Defaults to $OXAGEN_HOUSE_BRAND,
 *           then ../oxagen-house-brand beside this repo.
 * --check   verify the vendored files match what the kit would emit, write
 *           nothing, exit non-zero on drift. This is what CI runs.
 *
 * TWO BRAND RULES ARE ENFORCED HERE, not left to reviewers:
 *
 *   1. Oxagen's logo is the WORDMARK. The kit also emits an Oxagen lockup
 *      (the Ox mark in a plate, then the word); it is never shipped to a
 *      frontend. `FORBIDDEN` below fails the sync if one ever appears in a
 *      public directory.
 *   2. Stella's mark lives inside its word — `stella*`, the asterisk in gold.
 *      That combined form is the Stella lockup, and it is the only Stella
 *      lockup there is; the kit emits no separate one.
 *
 * PNG favicons follow the kit's own rule (build/build.py: build_favicons):
 * a PNG cannot adapt to the tab's colour scheme, and Oxagen's `Ox` is one
 * colour, so every Oxagen raster icon comes from the dark TILE — opaque and
 * legible wherever the tab is painted. The SVG favicon stays adaptive.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const brandArg = argv.indexOf("--brand");
const BRAND = resolve(
  brandArg >= 0 && argv[brandArg + 1]
    ? argv[brandArg + 1]
    : process.env.OXAGEN_HOUSE_BRAND || join(REPO, "../oxagen-house-brand"),
);

/** A lockup must never reach a frontend under this name. */
const FORBIDDEN = /oxagen-lockup/i;

/* ── the sizes each surface asks for ─────────────────────────────────────── */

const FAVICON_PNG = [16, 32, 48, 192, 512];
const ICO_SIZES = [16, 32, 48];
const PWA_ICONS = [72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512];
const MASKABLE = [192, 512];

/* ── rendering ───────────────────────────────────────────────────────────── */

/** Rasterise an SVG at an exact square size. rsvg-convert ships with librsvg. */
function raster(svgPath, size) {
  return execFileSync(
    "rsvg-convert",
    ["-w", String(size), "-h", String(size), "-f", "png", svgPath],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * A maskable icon is the tile with its corners let out and the mark pulled in
 * to the 80% safe circle Android masks against — otherwise a circular mask
 * clips the `Ox`. 0.72 keeps the glyph inside that circle with room to spare.
 */
function maskableSvg(tileSvgPath) {
  const src = readFileSync(tileSvgPath, "utf8");
  const inset = (96 * (1 - 0.72)) / 2;
  return src
    .replace(/(<rect width="96" height="96")\s+rx="20"/, "$1")
    .replace(
      /<g transform=/,
      `<g transform="translate(${inset} ${inset}) scale(0.72)"><g transform=`,
    )
    .replace(/<\/g><\/svg>$/, "</g></g></svg>");
}

/**
 * An .ico is a 6-byte header, a 16-byte directory entry per image, then the
 * payloads. Every modern target reads PNG payloads, so the PNGs the kit
 * already renders go in whole — no BMP re-encode, no extra dependency.
 */
function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const dir = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...pngs.map((p) => p.data)]);
}

/* ── writing ─────────────────────────────────────────────────────────────── */

const written = [];
const drifted = [];

function emit(relPath, data) {
  if (FORBIDDEN.test(relPath)) {
    throw new Error(
      `refusing to ship "${relPath}": Oxagen's logo is the wordmark, never the lockup`,
    );
  }
  const abs = join(REPO, relPath);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  let current = null;
  try {
    current = readFileSync(abs);
  } catch {
    /* new file */
  }
  const same = current && current.equals(buf);
  if (CHECK) {
    if (!same) drifted.push(relPath);
    return;
  }
  if (same) return;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  written.push(relPath);
}

const svg = (name) => join(BRAND, "logo/svg", name);
const copy = (from, to) => emit(to, readFileSync(join(BRAND, from)));

/* ── the plan ────────────────────────────────────────────────────────────── */

/**
 * Everything a Next.js surface (apps/app, apps/docs) needs under public/.
 * `brand` is oxagen or stella — which mark this surface wears.
 */
function nextSurface(publicDir, brand) {
  const tileDark = svg(`${brand}-icon-tile-dark.svg`);
  const tileLight = svg(`${brand}-icon-tile-light.svg`);

  // Marks. Adaptive first — one file that flips with the tab's colour scheme.
  // The dark/light pair is for grounds the page controls itself.
  for (const b of ["oxagen", "stella"]) {
    emit(
      `${publicDir}/brand/${b}-wordmark.svg`,
      readFileSync(svg(`${b}-wordmark-adaptive.svg`)),
    );
    emit(
      `${publicDir}/brand/${b}-wordmark-on-dark.svg`,
      readFileSync(svg(`${b}-wordmark-dark.svg`)),
    );
    emit(
      `${publicDir}/brand/${b}-wordmark-on-light.svg`,
      readFileSync(svg(`${b}-wordmark-light.svg`)),
    );
    emit(
      `${publicDir}/brand/${b}-icon.svg`,
      readFileSync(svg(`${b}-icon-adaptive.svg`)),
    );
    emit(
      `${publicDir}/brand/${b}-icon-tile-dark.svg`,
      readFileSync(svg(`${b}-icon-tile-dark.svg`)),
    );
    emit(
      `${publicDir}/brand/${b}-icon-tile-light.svg`,
      readFileSync(svg(`${b}-icon-tile-light.svg`)),
    );
  }

  // Favicons — adaptive SVG, opaque PNG fallbacks off the dark tile.
  emit(
    `${publicDir}/favicon/favicon.svg`,
    readFileSync(svg(`${brand}-favicon.svg`)),
  );
  const icoParts = [];
  for (const size of FAVICON_PNG) {
    const data = raster(tileDark, size);
    emit(`${publicDir}/favicon/favicon-${size}.png`, data);
    if (ICO_SIZES.includes(size)) icoParts.push({ size, data });
  }
  emit(`${publicDir}/favicon/favicon.ico`, ico(icoParts));

  // Home-screen / installed-PWA icons. A home-screen icon is a tile.
  for (const size of PWA_ICONS) {
    emit(`${publicDir}/pwa/icon-${size}.png`, raster(tileDark, size));
  }
  emit(`${publicDir}/pwa/apple-touch-icon.png`, raster(tileDark, 180));

  // Maskable: full bleed, mark pulled into the safe circle, both schemes.
  const scratch = mkdtempSync(join(tmpdir(), "oxagen-brand-"));
  const maskDark = join(scratch, `maskable-${brand}-dark.svg`);
  const maskLight = join(scratch, `maskable-${brand}-light.svg`);
  writeFileSync(maskDark, maskableSvg(tileDark));
  writeFileSync(maskLight, maskableSvg(tileLight));
  for (const size of MASKABLE) {
    emit(`${publicDir}/pwa/maskable-${size}.png`, raster(maskDark, size));
    emit(
      `${publicDir}/pwa/maskable-light-${size}.png`,
      raster(maskLight, size),
    );
  }

  // Social cards and the house spinner.
  copy(
    `social/${brand}-og-1200x630-dark.png`,
    `${publicDir}/social/og-image-dark-1200x630.png`,
  );
  copy(
    `social/${brand}-og-1200x630-light.png`,
    `${publicDir}/social/og-image-light-1200x630.png`,
  );
  copy(
    `spinners/${brand}-spinner.svg`,
    `${publicDir}/spinner/${brand}-spinner.svg`,
  );
  copy(
    `spinners/${brand}-spinner-wordmark.svg`,
    `${publicDir}/spinner/${brand}-spinner-wordmark.svg`,
  );
}

/** apps/web is a flat static site: assets sit beside index.html. */
function staticSurface(root, brand) {
  const tileDark = svg(`${brand}-icon-tile-dark.svg`);
  emit(`${root}/favicon.svg`, readFileSync(svg(`${brand}-favicon.svg`)));
  const icoParts = [];
  for (const size of [16, 32, 48]) {
    const data = raster(tileDark, size);
    if (size !== 48) emit(`${root}/favicon-${size}.png`, data);
    icoParts.push({ size, data });
  }
  emit(`${root}/favicon.ico`, ico(icoParts));
  emit(`${root}/apple-touch-icon.png`, raster(tileDark, 180));
  copy(`social/${brand}-og-1200x630-dark.png`, `${root}/og.png`);
  for (const b of ["oxagen", "stella"]) {
    emit(
      `${root}/assets/brand/${b}-wordmark.svg`,
      readFileSync(svg(`${b}-wordmark-adaptive.svg`)),
    );
    emit(
      `${root}/assets/brand/${b}-wordmark-on-dark.svg`,
      readFileSync(svg(`${b}-wordmark-dark.svg`)),
    );
    emit(
      `${root}/assets/brand/${b}-icon.svg`,
      readFileSync(svg(`${b}-icon-adaptive.svg`)),
    );
    emit(
      `${root}/assets/brand/${b}-icon-tile-dark.svg`,
      readFileSync(svg(`${b}-icon-tile-dark.svg`)),
    );
  }
  copy(
    `spinners/${brand}-spinner.svg`,
    `${root}/assets/brand/${brand}-spinner.svg`,
  );
}

/** The face. One copy, in @oxagen/ui, imported by every app. */
function fonts() {
  const dir = "packages/ui/src/styles/fonts";
  for (const f of readdirSync(join(BRAND, "fonts"))) {
    if (f.endsWith(".woff2")) copy(`fonts/${f}`, `${dir}/${f}`);
  }
  copy("fonts/LICENSE-OFL.txt", `${dir}/LICENSE-OFL.txt`);
}

/** The palette, verbatim from the kit, for anything that reads it as data. */
function tokens() {
  copy("tokens/house-tokens.css", "packages/ui/src/styles/house-tokens.css");
  copy("tokens/house-tokens.json", "packages/ui/src/styles/house-tokens.json");
}


/**
 * The marks, as data, for the React components in @oxagen/ui.
 *
 * <img src="…"> cannot follow the app theme, and hand-copying path data into a
 * .tsx is exactly the drift this script exists to prevent — so the geometry is
 * EXTRACTED from the kit's adaptive SVGs and written to a generated module the
 * components import. Every number in it came out of `build/marks.py`.
 *
 * Each wordmark is two paths: `letters`, which takes currentColor and so flips
 * with the theme, and `accent` — the ONE gold glyph (the `x` of oxagen, the
 * asterisk of stella). The icons are a single path inside a transform, one
 * colour, because the house rule is that a mark never carries the metal.
 */
function marks() {
  const read = (name) => readFileSync(svg(name), "utf8");
  const viewBox = (src) => src.match(/viewBox="([^"]+)"/)[1];
  const pathData = (src, cls) =>
    src.match(new RegExp(`<path class="${cls}" d="([^"]+)"`))[1];

  const wordmark = (brand) => {
    const src = read(`${brand}-wordmark-adaptive.svg`);
    const [, , w, h] = viewBox(src).split(/\s+/).map(Number);
    return {
      viewBox: viewBox(src),
      width: w,
      height: h,
      letters: pathData(src, "letters"),
      accent: pathData(src, "accent"),
    };
  };

  const icon = (brand) => {
    const src = read(`${brand}-icon-adaptive.svg`);
    return {
      viewBox: viewBox(src),
      transform: src.match(/<g transform="([^"]+)"/)[1],
      path: pathData(src, "mark"),
    };
  };

  const data = {
    oxagen: { wordmark: wordmark("oxagen"), icon: icon("oxagen") },
    stella: { wordmark: wordmark("stella"), icon: icon("stella") },
  };

  const gold = JSON.parse(readFileSync(join(BRAND, "tokens/house-tokens.json"), "utf8")).gold.hex;

  emit(
    "packages/ui/src/components/brand-marks.generated.ts",
    `/**
 * GENERATED by tools/scripts/sync-brand-assets.mjs from the Oxagen house brand
 * kit. Do not edit — run the sync instead.
 *
 * The kit reproduces both wordmarks from Space Grotesk itself (weight 600, one
 * em, HarfBuzz spacing including kerning) and both icons from the same face, so
 * the marks and the product's running text are the same outlines. Editing a
 * path here would break that; changing a mark means changing the kit.
 *
 * ONE GLYPH IS GOLD: the \`x\` in oxagen, the asterisk in stella. \`letters\`
 * renders in currentColor and flips with the theme; \`accent\` keeps the metal
 * in BOTH themes, which is what the kit's own light and dark files do — the
 * "gold becomes its deep shade on paper" rule governs WORDS, not the mark.
 *
 * The icons are one path and one colour by design. A two-colour mark has to be
 * redrawn for every ground it lands on; a one-colour mark is placed and
 * forgotten, and an operating system can tint it however it likes.
 */

/** The kit's gold, pinned. Identity only — never a surface, never a state. */
export const BRAND_GOLD = "${gold}";

export interface WordmarkGeometry {
  /** The kit's own viewBox — never re-fit it. */
  readonly viewBox: string;
  /** Intrinsic width in viewBox units; width follows height when sized. */
  readonly width: number;
  /** Intrinsic height in viewBox units. */
  readonly height: number;
  /** Every glyph but the accent. Renders in currentColor. */
  readonly letters: string;
  /** The single gold glyph. */
  readonly accent: string;
}

export interface IconGeometry {
  readonly viewBox: string;
  /** Places the glyph in the 96-unit box the kit fitted it to. */
  readonly transform: string;
  /** The whole mark, one path, one colour. */
  readonly path: string;
}

export interface BrandGeometry {
  readonly wordmark: WordmarkGeometry;
  readonly icon: IconGeometry;
}

export const OXAGEN: BrandGeometry = ${JSON.stringify(data.oxagen, null, 2)};

export const STELLA: BrandGeometry = ${JSON.stringify(data.stella, null, 2)};
`,
  );
}

/* ── run ─────────────────────────────────────────────────────────────────── */

try {
  readFileSync(join(BRAND, "tokens/house-tokens.json"));
} catch {
  console.error(
    `brand kit not found at ${BRAND}\n` +
      `clone macanderson/oxagen-house-brand beside this repo, or set OXAGEN_HOUSE_BRAND.`,
  );
  process.exit(2);
}

fonts();
tokens();
marks();
nextSurface("apps/app/public", "oxagen");
nextSurface("apps/docs/public", "oxagen");
staticSurface("apps/web", "oxagen");

const version = JSON.parse(
  readFileSync(join(BRAND, "tokens/house-tokens.json"), "utf8"),
).version;

if (CHECK) {
  if (drifted.length) {
    console.error(`brand assets are stale against house kit ${version}:`);
    for (const f of drifted) console.error(`  ${f}`);
    console.error(`\nrun: node tools/scripts/sync-brand-assets.mjs`);
    process.exit(1);
  }
  console.log(`brand: every vendored asset matches house kit ${version}`);
} else {
  const digest = createHash("sha256")
    .update(written.sort().join("\n"))
    .digest("hex")
    .slice(0, 12);
  console.log(
    written.length
      ? `brand: synced ${written.length} file(s) from house kit ${version} (${digest})`
      : `brand: already current with house kit ${version}`,
  );
}
