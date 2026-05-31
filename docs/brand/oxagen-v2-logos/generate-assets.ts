#!/usr/bin/env node
/**
 * Oxagen web asset generator.
 *
 * Rasterizes the brand SVG masters in ./assets into every asset a modern web app
 * needs: favicons (.ico + png), Apple touch icon, Android / PWA manifest icons,
 * maskable icon, a web manifest, and an on-brand Open Graph image.
 *
 * Usage:
 *   pnpm tsx scripts/generate-assets.ts            # generate everything
 *   pnpm tsx scripts/generate-assets.ts --outdir public
 *
 * Dependencies (devDependencies): sharp, png-to-ico, tsx (or ts-node)
 *
 * The script is intentionally dependency-light and logs each step so failures
 * are easy to trace in CI.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import pngToIco from "png-to-ico";

// ----------------------------- config -----------------------------

/** Brand colors. Not "picking colors" yet — these are neutral defaults used only
 *  for the OG background and maskable-icon safe-zone fill. Swap when brand color lands. */
const BRAND = {
  ink: "#0A0A0A",
  paper: "#FFFFFF",
  ogBg: "#0A0A0A",
  ogFg: "#FFFFFF",
} as const;

const ROOT = process.cwd();
const ASSETS_DIR = path.join(ROOT, "assets");

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] ?? "true";
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = path.join(ROOT, args.outdir ?? "public");

// Log helpers --------------------------------------------------------
const log = {
  info: (m: string) => console.log(`\x1b[36m•\x1b[0m ${m}`),
  ok: (m: string) => console.log(`\x1b[32m✓\x1b[0m ${m}`),
  warn: (m: string) => console.warn(`\x1b[33m!\x1b[0m ${m}`),
  err: (m: string) => console.error(`\x1b[31m✗\x1b[0m ${m}`),
};

// ----------------------------- helpers -----------------------------

async function readMaster(name: string): Promise<Buffer> {
  const p = path.join(ASSETS_DIR, name);
  try {
    return await fs.readFile(p);
  } catch {
    throw new Error(`Missing master SVG: ${p}`);
  }
}

/** Render an SVG buffer to a PNG of an exact square size, transparent background. */
async function svgToPng(
  svg: Buffer,
  size: number,
  opts: { background?: string; padding?: number } = {}
): Promise<Buffer> {
  const pad = opts.padding ?? 0;
  const inner = size - pad * 2;
  const rendered = await sharp(svg, { density: 384 })
    .resize(inner, inner, { fit: "contain", background: "#00000000" })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: opts.background ?? "#00000000",
    },
  })
    .composite([{ input: rendered, gravity: "center" }])
    .png()
    .toBuffer();
}

async function writePng(buf: Buffer, file: string) {
  const p = path.join(OUT_DIR, file);
  await fs.writeFile(p, buf);
  log.ok(`${file} (${(buf.length / 1024).toFixed(1)} KiB)`);
}

// ----------------------------- tasks -----------------------------

/** Favicon PNGs + multi-resolution .ico. Uses the logomark (adaptive prefers a
 *  solid mark for favicons, so we use the black master on transparent and let the
 *  browser tab background show through; most browsers render tabs light/dark aware). */
async function buildFavicons(markBlack: Buffer, markWhite: Buffer) {
  log.info("favicons");
  const sizes = [16, 32, 48, 64, 96, 192, 512];
  const icoSizes = [16, 32, 48];
  const icoBuffers: Buffer[] = [];

  for (const s of sizes) {
    const png = await svgToPng(markBlack, s);
    await writePng(png, `favicon-${s}x${s}.png`);
    if (icoSizes.includes(s)) icoBuffers.push(png);
  }

  // White variant for browsers that request a dark-theme icon
  await writePng(await svgToPng(markWhite, 32), "favicon-32x32-dark.png");

  const ico = await pngToIco(icoBuffers);
  await fs.writeFile(path.join(OUT_DIR, "favicon.ico"), ico);
  log.ok(`favicon.ico (${(ico.length / 1024).toFixed(1)} KiB, ${icoSizes.join("/")})`);
}

/** Apple touch icon — 180x180, opaque background (iOS ignores transparency and
 *  composites on black otherwise). White mark on ink. */
async function buildAppleTouch(markWhite: Buffer) {
  log.info("apple touch icon");
  const png = await svgToPng(markWhite, 180, { background: BRAND.ink, padding: 28 });
  await writePng(png, "apple-touch-icon.png");
}

/** Android / PWA icons + a maskable icon (safe-zone padded so launchers can crop). */
async function buildPwaIcons(markBlack: Buffer, markWhite: Buffer) {
  log.info("pwa / android icons");
  for (const s of [192, 512]) {
    await writePng(await svgToPng(markBlack, s), `icon-${s}.png`);
  }
  // Maskable: 512 with ~20% safe-zone padding on an opaque field.
  const maskable = await svgToPng(markWhite, 512, {
    background: BRAND.ink,
    padding: Math.round(512 * 0.2),
  });
  await writePng(maskable, "icon-maskable-512.png");
}

/** web app manifest wiring the icons. */
async function buildManifest() {
  log.info("web manifest");
  const manifest = {
    name: "Oxagen",
    short_name: "Oxagen",
    description: "Ontology infrastructure for AI agents.",
    start_url: "/",
    display: "standalone",
    background_color: BRAND.paper,
    theme_color: BRAND.ink,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
  await fs.writeFile(
    path.join(OUT_DIR, "site.webmanifest"),
    JSON.stringify(manifest, null, 2)
  );
  log.ok("site.webmanifest");
}

/** Open Graph image — 1200x630, on-brand: ink field, centered horizontal lockup,
 *  subtle node-graph motif. Built as an SVG composited to PNG so it stays crisp. */
async function buildOgImage(lockupWhite: Buffer) {
  log.info("open graph image");
  const W = 1200;
  const H = 630;

  // place the horizontal lockup (white) centered, ~62% width
  const lockup = await sharp(lockupWhite, { density: 384 })
    .resize(Math.round(W * 0.62), null, { fit: "inside" })
    .png()
    .toBuffer();

  // faint background graph motif (decorative dots + edges) — neutral, no brand color yet
  const dots = Array.from({ length: 7 }, (_, i) => {
    const x = 90 + i * 165;
    const y = i % 2 ? 90 : H - 90;
    return `<circle cx="${x}" cy="${y}" r="6" fill="#FFFFFF" opacity="0.14"/>`;
  }).join("");
  const edges = `
    <line x1="90" y1="540" x2="255" y2="90" stroke="#FFFFFF" stroke-width="2" opacity="0.08"/>
    <line x1="255" y1="90" x2="420" y2="540" stroke="#FFFFFF" stroke-width="2" opacity="0.08"/>
    <line x1="780" y1="90" x2="945" y2="540" stroke="#FFFFFF" stroke-width="2" opacity="0.08"/>
    <line x1="945" y1="540" x2="1110" y2="90" stroke="#FFFFFF" stroke-width="2" opacity="0.08"/>`;
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
       <rect width="${W}" height="${H}" fill="${BRAND.ogBg}"/>
       ${edges}${dots}
     </svg>`
  );

  const og = await sharp(bg)
    .composite([{ input: lockup, gravity: "center" }])
    .png()
    .toBuffer();
  await writePng(og, "og-image.png");
}

/** Emit a copy-paste <head> snippet so wiring the assets is trivial. */
async function buildHeadSnippet() {
  const snippet = `<!-- Oxagen favicons & meta — generated by scripts/generate-assets.ts -->
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32-dark.png" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="${BRAND.paper}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${BRAND.ink}" media="(prefers-color-scheme: dark)">
<meta property="og:image" content="/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="/og-image.png">`;
  await fs.writeFile(path.join(OUT_DIR, "head-snippet.html"), snippet);
  log.ok("head-snippet.html");
}

// ----------------------------- main -----------------------------

async function main() {
  const start = Date.now();
  log.info(`output → ${path.relative(ROOT, OUT_DIR) || "."}`);
  await fs.mkdir(OUT_DIR, { recursive: true });

  const [markBlack, markWhite, lockupWhite] = await Promise.all([
    readMaster("logomark-black.svg"),
    readMaster("logomark-white.svg"),
    readMaster("horizontal-lockup-white.svg"),
  ]);

  await buildFavicons(markBlack, markWhite);
  await buildAppleTouch(markWhite);
  await buildPwaIcons(markBlack, markWhite);
  await buildManifest();
  await buildOgImage(lockupWhite);
  await buildHeadSnippet();

  log.ok(`done in ${((Date.now() - start) / 1000).toFixed(2)}s`);
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
