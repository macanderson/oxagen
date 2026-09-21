#!/usr/bin/env node
/**
 * Pull the Oxagen house brand system into every frontend in this repo.
 *
 * The house kit (oxagenai/oxagen-brand) generates every mark, icon,
 * social card and spinner from `build/`. Nothing in it is drawn by hand, so
 * nothing here is copied by hand either: this script is the one seam between
 * the kit and the apps, and re-running it after a kit rebuild re-flows the
 * whole product.
 *
 *   node tools/scripts/sync-brand-assets.mjs [--brand <dir>] [--check]
 *
 * --brand   kit checkout. Defaults to $OXAGEN_BRAND_KIT, then the deprecated
 *           $OXAGEN_HOUSE_BRAND alias, then ../oxagen-brand.
 * --check   verify vendored files without writing. Exit non-zero on drift.
 *
 * Each surface has an explicit mark allowlist. The product uses the wordmark
 * where a word fits and the hive for square icons. The kit also supplies a
 * lockup, but no current product surface selects it. Stella uses its wordmark
 * and asterisk. Raster icons use the opaque dark tile; SVG favicons adapt.

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
export function brandPath(args, env, repo = REPO) {
  const brandArg = args.indexOf("--brand");
  return resolve(
    brandArg >= 0 && args[brandArg + 1]
      ? args[brandArg + 1]
      : env.OXAGEN_BRAND_KIT ||
          env.OXAGEN_HOUSE_BRAND ||
          join(repo, "../oxagen-brand"),
  );
}
const BRAND = brandPath(argv, process.env);

const NEXT_MARKS = ["oxagen", "stella"].flatMap((brand) =>
  [
    "wordmark",
    "wordmark-on-dark",
    "wordmark-on-light",
    "icon",
    "icon-tile-dark",
    "icon-tile-light",
    "avatar-light",
    "avatar-dark",
  ].map((variant) => `${brand}-${variant}.svg`),
);
const SURFACE_MARKS = {
  "apps/app/public/brand": NEXT_MARKS,
  "apps/docs/public/brand": NEXT_MARKS,
  "apps/app_deprecated/public/brand": NEXT_MARKS,
  "apps/web/assets/brand": [
    "wordmark",
    "wordmark-on-dark",
    "icon",
    "icon-tile-dark",
    "spinner",
  ].map((variant) => `oxagen-${variant}.svg`),
};

/** Reject an unselected mark before writing or checking the surface. */
export function assertSurfaceMark(relPath) {
  const marker = relPath.indexOf("/brand/");
  if (marker < 0) return;
  const surface = relPath.slice(0, marker + "/brand".length);
  const file = relPath.slice(marker + "/brand/".length);
  if (!SURFACE_MARKS[surface]?.includes(file)) {
    throw new Error(`mark is not selected for ${surface}: ${file}`);
  }
}

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
 * A maskable icon is the source square with its corners let out and the mark
 * pulled in to the 80% safe circle a round mask keeps — otherwise the mask
 * clips the glyph.
 *
 * Only the MARK moves. The ground — the background square and any wash over
 * it — is left at full size, so it still bleeds into the corners the circle
 * gives up. Shrinking the whole square and backing it with a flat fill looks
 * right until the art carries a wash: the hive avatar's radial warm-up then
 * stops at 80% and leaves a visible rounded seam. In every square the kit
 * emits, the mark is the first `<g transform=` — the hive's placement group in
 * an avatar, the glyph's in a tile. Rounded corners come off, because the
 * system mask draws its own.
 *
 * `scale` is how much of the square the mark may occupy. The default 0.72 is
 * what the `Ox` tile has always used; the hive sits wider in its own canvas
 * and passes its own value.
 */
function maskableSvg(sourceSvgPath, scale = 0.72) {
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
  assertSurfaceMark(relPath);
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
    // The avatar — the hive full-bleed on its ground. This is the face the
    // brand wears where the image IS the brand rather than a mark inside a
    // page: social profiles, and the desktop app icon that
    // apps/desktop/scripts/icons.mjs cuts from these.
    emit(
      `${publicDir}/brand/${b}-avatar-light.svg`,
      readFileSync(join(BRAND, `social/${b}-avatar-light.svg`)),
    );
    emit(
      `${publicDir}/brand/${b}-avatar-dark.svg`,
      readFileSync(join(BRAND, `social/${b}-avatar-dark.svg`)),
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

/**
 * Next.js App Router file-convention favicon (`src/app/icon.svg`). When this
 * file exists it is served at /icon and can override layout metadata icons, so
 * it must be the same hive favicon the kit emits — never a retired mark.
 */
function nextAppIcon(appDir, brand) {
  emit(`${appDir}/src/app/icon.svg`, readFileSync(svg(`${brand}-favicon.svg`)));
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
  // Home-screen / installed-PWA icons — same tiles the Next surfaces wear.
  for (const size of [192, 512]) {
    emit(`${root}/icon-${size}.png`, raster(tileDark, size));
  }
  const scratch = mkdtempSync(join(tmpdir(), "oxagen-brand-web-"));
  const maskDark = join(scratch, `maskable-${brand}-dark.svg`);
  writeFileSync(maskDark, maskableSvg(tileDark));
  for (const size of MASKABLE) {
    emit(`${root}/maskable-${size}.png`, raster(maskDark, size));
  }
  // Kit webmanifest with paths rewritten for the flat static layout.
  const kitManifest = JSON.parse(
    readFileSync(join(BRAND, `icons/${brand}.webmanifest`), "utf8"),
  );
  emit(
    `${root}/${brand}.webmanifest`,
    `${JSON.stringify(
      {
        ...kitManifest,
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/maskable-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  copy(`social/${brand}-og-1200x630-dark.png`, `${root}/og.png`);
  for (const b of [brand]) {
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
  // The palette itself, so the static site references the kit's tokens rather
  // than a hand-transcribed copy of them. Its own stylesheet imports this file
  // and aliases onto it, which is what makes "byte-for-byte off the kit" true
  // by construction instead of true until someone edits a hex.
  copy("tokens/house-tokens.css", `${root}/assets/house-tokens.css`);
  // The static site serves its faces from /fonts/: the kit's three, beside
  // whatever else the site ships there.
  for (const f of readdirSync(join(BRAND, "fonts"))) {
    if (f.endsWith(".woff2") || f.startsWith("LICENSE"))
      copy(`fonts/${f}`, `${root}/fonts/${f}`);
  }
}

/**
 * The branding skill: positioning, voice, vocabulary, worked examples. It is
 * authored in the kit beside the marks it describes and vendored here so the
 * agents working this tree read the same words the ads and the site carry.
 * Edit it in the kit, run the sync, commit both; `--check` fails on drift.
 */
function skill() {
  const walk = (rel) => {
    for (const entry of readdirSync(join(BRAND, rel), {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".")) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else copy(child, `.claude/${child}`);
    }
  };
  walk("skills/oxagen-branding");
}

/**
 * The three faces: Space Grotesk (display), Geist (text), Monaspace Neon (code).
 * One copy, in @oxagen/ui, imported by every app. `house-fonts.css` is the
 * kit's @font-face file with its paths moved from ../fonts/ to ./fonts/.
 */
function fonts() {
  const dir = "packages/ui/src/styles/fonts";
  for (const f of readdirSync(join(BRAND, "fonts"))) {
    if (f.endsWith(".woff2") || f.startsWith("LICENSE"))
      copy(`fonts/${f}`, `${dir}/${f}`);
  }
  emit(
    "packages/ui/src/styles/house-fonts.css",
    readFileSync(join(BRAND, "tokens/house-fonts.css"), "utf8").replaceAll(
      "url(../fonts/",
      "url(./fonts/",
    ),
  );
}

/**
 * The palette, verbatim from the kit, for anything that reads it as data.
 *
 * `house-tailwind.css` is the layer that turns the palette into something an
 * app can write: the `--color-ox-*` theme entries, the shadcn/Base UI
 * semantic names, the tracking scale, and the twelve type utilities
 * (`text-m-*` for a page read once, `text-a-*` for a dashboard read all day).
 * It went unvendored until 2026-09-19, so the kit's TYPE SCALE did not exist
 * in this repo at all and every surface sized itself with Tailwind's defaults
 * and one-off `text-[11px]` literals. It imports `house-tokens.css` from
 * beside it, which is why `globals.css` imports this file rather than both.
 */
function tokens() {
  copy("tokens/house-tokens.css", "packages/ui/src/styles/house-tokens.css");
  copy("tokens/house-tokens.json", "packages/ui/src/styles/house-tokens.json");
  copy(
    "tokens/house-tailwind.css",
    "packages/ui/src/styles/house-tailwind.css",
  );
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
 * asterisk of stella). The hive keeps each outline and gold cell from the kit.
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

  // An icon is one or more parts. Stella's is one gold glyph. Oxagen's hive is
  // four cells outlined in the surface's ink and two filled with the metal,
  // one at half strength. Each part keeps the role the kit gave it: `ink`
  // takes currentColor, `accent` takes the gold.
  const icon = (brand) => {
    const src = read(`${brand}-icon-adaptive.svg`);
    const parts = [...src.matchAll(/<path\b([^>]*)\/>/g)].map(([, attrs]) => {
      const attr = (name) =>
        attrs.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
      const stroked = attr("stroke") === "currentColor";
      const part = {
        d: attr("d"),
        role: stroked || attr("fill") === "currentColor" ? "ink" : "accent",
      };
      if (stroked) part.strokeWidth = Number(attr("stroke-width") ?? 1);
      if (attr("opacity")) part.opacity = Number(attr("opacity"));
      return part;
    });
    if (!parts.length)
      throw new Error(`no paths in ${brand}-icon-adaptive.svg`);
    return {
      viewBox: viewBox(src),
      transform: src.match(/<g transform="([^"]+)"/)[1],
      parts,
    };
  };

  const data = {
    oxagen: { wordmark: wordmark("oxagen"), icon: icon("oxagen") },
    stella: { wordmark: wordmark("stella"), icon: icon("stella") },
  };

  const gold = JSON.parse(
    readFileSync(join(BRAND, "tokens/house-tokens.json"), "utf8"),
  ).gold.hex;

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
 * An icon is a list of parts. Stella's is the gold asterisk alone. Oxagen's is
 * the hive: cell outlines in currentColor (\`ink\`) and two cells in the gold
 * (\`accent\`), one at half strength. A mono tone paints every part one colour.
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

export interface IconPart {
  readonly d: string;
  /** \`ink\` takes currentColor; \`accent\` takes the gold. */
  readonly role: "ink" | "accent";
  /** Set on an outlined part: it is stroked, not filled. */
  readonly strokeWidth?: number;
  readonly opacity?: number;
}

export interface IconGeometry {
  readonly viewBox: string;
  /** Places the mark in the 96-unit box the kit fitted it to. */
  readonly transform: string;
  readonly parts: readonly IconPart[];
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

/**
 * The kit is a separate repository, so it is not always present — CI checks out
 * this repo alone.
 *
 * A WRITE without it is an error: there is nothing to copy from. A `--check`
 * without it says so and exits 0, because the alternative is a gate that fails
 * on every machine that has not cloned a second repo, and a gate everyone
 * learns to ignore is worse than no gate. It says it LOUDLY rather than
 * skipping quietly: the one line names what was not checked, so a green run
 * with that line in it cannot be read as "the assets were verified".
 *
 * What is lost is small and visible: the vendored files are committed, so the
 * only drift this misses is someone hand-editing one, which shows up in the
 * diff of the PR that does it.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    readFileSync(join(BRAND, "tokens/house-tokens.json"));
  } catch {
    const where =
      "Clone oxagenai/oxagen-brand beside this repo or set OXAGEN_BRAND_KIT.";
    if (CHECK) {
      console.log(
        `brand: SKIPPED. No house kit at ${BRAND}, so no asset was verified. ${where}`,
      );
      process.exit(0);
    }
    console.error(`brand kit not found at ${BRAND}\n${where}`);
    process.exit(2);
  }

  for (const surface of Object.keys(SURFACE_MARKS)) {
    try {
      for (const file of readdirSync(join(REPO, surface))) {
        assertSurfaceMark(`${surface}/${file}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  skill();
  fonts();
  tokens();
  marks();
  nextSurface("apps/app/public", "oxagen");
  nextSurface("apps/docs/public", "oxagen");
  // Deprecated app still boots locally and in archive deploys; keep its public
  // marks on the same kit tip as the live surfaces so a stray open does not
  // show the retired Ox lettermark or cream paper.
  nextSurface("apps/app_deprecated/public", "oxagen");
  nextAppIcon("apps/docs", "oxagen");
  nextAppIcon("apps/app_deprecated", "oxagen");
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
}
