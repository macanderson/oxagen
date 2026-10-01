#!/usr/bin/env node
/**
 * Copy the Oxagen brand kit into this repo, or check that the copies still
 * match it.
 *
 * The kit, oxageninc/brand, builds every mark, icon, social card,
 * launch screen, and spinner with the scripts in its `build/` folder and
 * commits the result. This script copies those committed files byte for byte,
 * so nobody edits a brand file here by hand. It renders nothing: every PNG and
 * ICO here is the kit's own file. It needs Node and nothing else, which is
 * what the kit's fan-out workflow gives it (Ubuntu, Node 24, no network).
 *
 *   node tools/scripts/sync-brand-assets.mjs [--brand <dir>] [--check]
 *
 * --brand   the kit folder. Without it, the script reads $OXAGEN_BRAND_KIT,
 *           then ../oxagen-brand beside this repo.
 * --check   write nothing. List every file that differs from the kit, is
 *           missing, or should not be there, and exit 1. Exit 0 when the repo
 *           matches. A check right after a sync passes.
 *
 * With no kit at that path, both modes exit 2: a check that could not run
 * must not pass (#4804).
 *
 * What the script writes, all from the kit:
 *
 * - the marks, favicons, app icons, maskable icons, launch screens, social
 *   cards, spinner, and install prompt of apps/app, apps/docs,
 *   apps/app_deprecated, and apps/web;
 * - the tokens, the Tailwind layer, and the three faces in
 *   packages/ui/src/styles/;
 * - three generated modules: the marks as path data
 *   (packages/ui/src/components/brand-marks.generated.ts), the launch screens
 *   (packages/ui/src/lib/splash-screens.ts), and the two grounds as hex
 *   (packages/ui/src/lib/house-grounds.ts);
 * - apps/web's palette for generated images (`INK` in
 *   apps/web/scripts/lib/theme.mjs), its web manifest, and the launch-screen
 *   block in each hand-authored page's <head>;
 * - the branding skill stub at .claude/skills/oxagen-branding/SKILL.md. Every
 *   other file in that folder is removed: agents read the full skill from the
 *   kit's main branch.
 *
 * The folders that hold only kit files (each Next surface's favicon/ and
 * pwa/, apps/web/splash/, and apps/web's root icons) are reconciled: a sync
 * removes a file there that the kit no longer ships, and a check lists it.
 *
 * The desktop app's icons are the one brand file this script cannot write.
 * apps/desktop/scripts/icons.mjs cuts them from the synced avatar with
 * rsvg-convert and the Tauri CLI, and records in
 * apps/desktop/src-tauri/icons/source.sha256 the sha256 of the avatar and of
 * every file it wrote. This script compares that stamp with the avatar it
 * syncs and with the committed icons, so a kit icon change, or an icon
 * edited by hand, fails the check until someone runs
 * `pnpm --filter @oxagen/desktop icons` (#4892).
 *
 * CI runs `--check` against the kit's main branch in brand-drift.yml and in
 * the pipeline's checks job, as Mac decided on 2026-09-29 (#3074). After a
 * kit change lands on main, the check fails here until someone runs this
 * script and commits the result. The kit's fan-out workflow opens that PR.
 *
 * SURFACE_MARKS lists the marks each app may carry. The product shows the
 * wordmark where a word fits and the hive where the slot is square. The kit
 * also ships a lockup, and no app selects it. Stella uses its wordmark and
 * its asterisk.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INK_TOKENS } from "../../apps/web/scripts/lib/theme.mjs";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");

/**
 * The kit folder: `--brand <dir>`, else $OXAGEN_BRAND_KIT, else
 * ../oxagen-brand beside the repo.
 */
export function brandPath(args, env, repo = REPO) {
  const brandArg = args.indexOf("--brand");
  return resolve(
    brandArg >= 0 && args[brandArg + 1]
      ? args[brandArg + 1]
      : env.OXAGEN_BRAND_KIT || join(repo, "../oxagen-brand"),
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

/* ── launch screens ──────────────────────────────────────────────────────── */

/**
 * One `apple-touch-startup-image` per screen and scheme. The kit's
 * `splash/splash-screens.json` names each screen's file and the media query
 * Safari matches it on. Safari shows a launch screen only when that query
 * matches the device exactly, and the scheme picks the ink or the paper one.
 *
 * @param {{ file: string, media: string }[]} screens
 * @param {string} brand
 * @param {string} base URL directory the images are served from, ending in /
 * @returns {{ url: string, media: string }[]}
 */
export function startupImages(screens, brand, base) {
  return ["dark", "light"].flatMap((scheme) =>
    screens.map((s) => ({
      url: base + s.file.replace("{brand}", brand).replace("{scheme}", scheme),
      media: `${s.media} and (prefers-color-scheme: ${scheme})`,
    })),
  );
}

/** The files `startupImages` points at, as kit paths. */
function splashFiles(screens, brand) {
  return ["dark", "light"].flatMap((scheme) =>
    screens.map((s) =>
      s.file.replace("{brand}", brand).replace("{scheme}", scheme),
    ),
  );
}

const PWA_BEGIN = "<!-- pwa: written by tools/scripts/sync-brand-assets.mjs -->";
const PWA_END = "<!-- /pwa -->";

/**
 * The block of <head> tags a static page needs to launch like an app: the
 * iOS home-screen metas, one launch screen per device, and the install prompt.
 *
 * @param {{ url: string, media: string }[]} images
 * @param {{ title: string, script: string, icon: string }} o
 */
export function staticPwaHead(images, { title, script, icon }) {
  const attr = (v) => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return [
    PWA_BEGIN,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
    `<meta name="apple-mobile-web-app-title" content="${attr(title)}">`,
    ...images.map(
      (i) =>
        `<link rel="apple-touch-startup-image" media="${attr(i.media)}" href="${attr(i.url)}">`,
    ),
    `<script src="${attr(script)}" defer data-icon="${attr(icon)}"></script>`,
    PWA_END,
  ].join("\n");
}

/**
 * `html` with its pwa block set to `block`. A page that has none yet gets it
 * after its manifest link, which every page of the static site carries. Throws
 * when there is neither, so a page cannot silently go without.
 */
export function withPwaHead(html, block) {
  const start = html.indexOf(PWA_BEGIN);
  if (start >= 0) {
    const end = html.indexOf(PWA_END, start);
    if (end < 0) throw new Error("pwa block has no end marker");
    return html.slice(0, start) + block + html.slice(end + PWA_END.length);
  }
  const manifest = html.match(/<link rel="manifest"[^>]*>\n/);
  if (!manifest) throw new Error("page has no manifest link to place the pwa block after");
  const at = manifest.index + manifest[0].length;
  return `${html.slice(0, at)}${block}\n${html.slice(at)}`;
}

/* ── the desktop icons ───────────────────────────────────────────────────── */

/** The desktop app's icons, which apps/desktop/scripts/icons.mjs cuts. */
const DESKTOP_ICONS = "apps/desktop/src-tauri/icons";
/** Where that cut records what it read and what it wrote. */
const DESKTOP_STAMP = `${DESKTOP_ICONS}/source.sha256`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Whether the desktop icons are the ones a cut from the synced avatar wrote.
 *
 * `stamp` is the text of DESKTOP_STAMP, or null when there is none. It is in
 * `shasum -a 256` form: the first line is the hash and repo path of the SVG
 * the icons were cut from, and each line after it is the hash and repo path
 * of a file the cut wrote. `synced` maps each path this run writes to its
 * bytes. `icons` maps every other file in DESKTOP_ICONS to its bytes.
 * Returns null when everything matches, or the first reason it does not.
 *
 * @param {string | null} stamp
 * @param {ReadonlyMap<string, Buffer>} synced
 * @param {ReadonlyMap<string, Buffer>} icons
 * @returns {string | null}
 */
export function desktopIconDrift(stamp, synced, icons) {
  if (stamp === null) return "no stamp, so no record of what the icons were cut from";
  const lines = stamp.trim().split("\n").map((l) => l.match(/^([0-9a-f]{64}) [ *]?(\S+)$/));
  if (lines.some((l) => !l)) return "the stamp is not `<sha256>  <path>` lines";
  const [[, hash, source], ...outputs] = lines;
  const bytes = synced.get(source);
  if (!bytes) return `the stamp names ${source}, which this sync does not write`;
  if (sha256(bytes) !== hash) return `the icons were cut from an older ${source}`;
  const listed = new Set();
  for (const [, want, path] of outputs) {
    listed.add(path);
    const file = icons.get(path);
    if (!file) return `${path} is in the stamp but missing`;
    if (sha256(file) !== want) return `${path} changed after the cut`;
  }
  for (const path of icons.keys()) {
    if (!listed.has(path)) return `${path} is not in the stamp, so no cut wrote it`;
  }
  return null;
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/** Each path this run writes, with the bytes it holds when the repo matches. */
const synced = new Map();
const written = [];
const removed = [];
/** `{ kind, path, why? }` for each file a --check found out of step. */
const drifted = [];

function committed(relPath) {
  try {
    return readFileSync(join(REPO, relPath));
  } catch {
    return null;
  }
}

function emit(relPath, data) {
  assertSurfaceMark(relPath);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  synced.set(relPath, buf);
  const current = committed(relPath);
  if (current?.equals(buf)) return;
  if (CHECK) {
    drifted.push({ kind: current ? "differs" : "missing", path: relPath });
    return;
  }
  const abs = join(REPO, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  written.push(relPath);
}

const svg = (name) => join(BRAND, "logo/svg", name);
const kitScreens = () =>
  JSON.parse(readFileSync(join(BRAND, "splash/splash-screens.json"), "utf8"))
    .screens;
const copy = (from, to) => emit(to, readFileSync(join(BRAND, from)));

/**
 * Every file under `relDir` except `keep`, as repo paths. With `deep` false,
 * only the files directly in it. Finder's `.DS_Store` is skipped, since git
 * never carries it.
 */
function filesUnder(relDir, keep, deep = true) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(REPO, rel), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (deep) walk(child);
      } else if (entry.name !== ".DS_Store" && child !== keep) out.push(child);
    }
  };
  walk(relDir);
  return out;
}

/**
 * A file in a folder this script owns that the run did not write: the kit no
 * longer ships it. A sync removes it, and a check lists it as extra.
 */
function stray(rel) {
  if (CHECK) {
    drifted.push({ kind: "extra", path: rel });
    return;
  }
  rmSync(join(REPO, rel));
  removed.push(rel);
}

/**
 * Remove or list every file under `relDir` this run did not write. Only
 * folders that hold nothing but kit files are reconciled. `only`, when given,
 * limits the sweep to the file names it matches, for a folder the kit shares
 * with other files.
 */
function reconcile(relDir, { deep = true, only } = {}) {
  for (const rel of filesUnder(relDir, undefined, deep)) {
    if (synced.has(rel)) continue;
    if (only && !only.test(rel.slice(rel.lastIndexOf("/") + 1))) continue;
    stray(rel);
  }
}

/* ── the plan ────────────────────────────────────────────────────────────── */

/** The sizes the kit ships each icon at, in icons/. */
const FAVICON_PNG = [16, 32, 48, 192, 512];
const PWA_ICONS = [180, 192, 512];
const MASKABLE = [192, 512];

/**
 * Everything a Next.js surface (apps/app, apps/docs) needs under public/.
 * `brand` is oxagen or stella, the mark this surface wears.
 */
function nextSurface(publicDir, brand, { pwa = true } = {}) {
  // Marks. Adaptive first: one file that flips with the tab's colour scheme.
  // The dark and light pair is for grounds the page controls itself.
  for (const b of ["oxagen", "stella"]) {
    copy(`logo/svg/${b}-wordmark-adaptive.svg`, `${publicDir}/brand/${b}-wordmark.svg`);
    copy(`logo/svg/${b}-wordmark-dark.svg`, `${publicDir}/brand/${b}-wordmark-on-dark.svg`);
    copy(`logo/svg/${b}-wordmark-light.svg`, `${publicDir}/brand/${b}-wordmark-on-light.svg`);
    copy(`logo/svg/${b}-icon-adaptive.svg`, `${publicDir}/brand/${b}-icon.svg`);
    copy(`logo/svg/${b}-icon-tile-dark.svg`, `${publicDir}/brand/${b}-icon-tile-dark.svg`);
    copy(`logo/svg/${b}-icon-tile-light.svg`, `${publicDir}/brand/${b}-icon-tile-light.svg`);
    // The avatar: the hive full-bleed on its ground. Social profiles wear it,
    // and apps/desktop/scripts/icons.mjs cuts the desktop app icon from it.
    copy(`social/${b}-avatar-light.svg`, `${publicDir}/brand/${b}-avatar-light.svg`);
    copy(`social/${b}-avatar-dark.svg`, `${publicDir}/brand/${b}-avatar-dark.svg`);
  }

  // Favicons: the adaptive SVG, then the kit's PNGs and .ico on the obsidian
  // tile. The kit draws 16 to 48 from its favicon tile, whose outline is
  // heavier so the hive holds at tab size.
  copy(`logo/svg/${brand}-favicon.svg`, `${publicDir}/favicon/favicon.svg`);
  for (const size of FAVICON_PNG) {
    copy(`icons/${brand}-icon-${size}.png`, `${publicDir}/favicon/favicon-${size}.png`);
  }
  copy(`icons/${brand}-favicon.ico`, `${publicDir}/favicon/favicon.ico`);

  // Home-screen and installed-app icons. A home-screen icon is a tile.
  for (const size of PWA_ICONS) {
    copy(`icons/${brand}-icon-${size}.png`, `${publicDir}/pwa/icon-${size}.png`);
  }
  copy(`icons/${brand}-icon-180.png`, `${publicDir}/pwa/apple-touch-icon.png`);
  // Maskable: full bleed, the mark inside the safe circle, both schemes.
  for (const size of MASKABLE) {
    copy(`icons/${brand}-icon-maskable-${size}.png`, `${publicDir}/pwa/maskable-${size}.png`);
    copy(
      `icons/${brand}-icon-maskable-light-${size}.png`,
      `${publicDir}/pwa/maskable-light-${size}.png`,
    );
  }

  // Launch screens for the installed app, and the install prompt. The root
  // layout lists the screens from @oxagen/ui/lib/splash-screens.
  if (pwa) {
    for (const file of splashFiles(kitScreens(), brand)) {
      copy(`splash/${file}`, `${publicDir}/pwa/splash/${file}`);
    }
    copy("pwa/install-prompt.js", `${publicDir}/pwa/install-prompt.js`);
  }

  // Social cards and the house spinner.
  copy(`social/${brand}-og-1200x630-dark.png`, `${publicDir}/social/og-image-dark-1200x630.png`);
  copy(`social/${brand}-og-1200x630-light.png`, `${publicDir}/social/og-image-light-1200x630.png`);
  copy(`spinners/${brand}-spinner.svg`, `${publicDir}/spinner/${brand}-spinner.svg`);
  copy(
    `spinners/${brand}-spinner-wordmark.svg`,
    `${publicDir}/spinner/${brand}-spinner-wordmark.svg`,
  );
}

/**
 * Next.js App Router file-convention favicon (`src/app/icon.svg`). When this
 * file exists it is served at /icon and can override layout metadata icons, so
 * it must be the same hive favicon the kit emits.
 */
function nextAppIcon(appDir, brand) {
  copy(`logo/svg/${brand}-favicon.svg`, `${appDir}/src/app/icon.svg`);
}

/** The hand-authored pages of apps/web. The blog's pages import PWA_HEAD. */
const STATIC_PAGES = [
  "index.html",
  "story/index.html",
  "read/index.html",
  "products/oxagen/index.html",
];

/**
 * The launch screens, as data, for the Next.js root layouts: their
 * `appleWebApp.startupImage`. Every Next surface serves them from /pwa/splash/.
 */
function splashModule(brand) {
  emit(
    "packages/ui/src/lib/splash-screens.ts",
    `/**
 * GENERATED by tools/scripts/sync-brand-assets.mjs from the house kit's
 * splash/splash-screens.json. Do not edit; run the sync.
 *
 * One launch screen per iPhone and iPad screen size and scheme: the kit's
 * \`word\` phone wallpaper. Safari shows one only when its media query
 * matches the device exactly. Each Next surface serves the images from
 * /pwa/splash/ and passes this list as \`appleWebApp.startupImage\`.
 */

export interface StartupImage {
  readonly url: string;
  readonly media: string;
}

export const APPLE_STARTUP_IMAGES: readonly StartupImage[] = ${JSON.stringify(
      startupImages(kitScreens(), brand, "/pwa/splash/"),
      null,
      2,
    )};
`,
  );
}

/**
 * The two grounds as hex, for the places that cannot read a CSS variable: a
 * web app manifest's theme and background colours, and the theme-color metas
 * a root layout declares (#4892).
 *
 * @param {Record<string, unknown>} kitTokens the kit's `tokens` map
 */
export function houseGroundsModule(kitTokens) {
  const hex = (name) => {
    const value = kitTokens[name];
    if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
      throw new Error(`house kit has no colour token "${name}"`);
    }
    return value;
  };
  return `/**
 * GENERATED by tools/scripts/sync-brand-assets.mjs from the house kit's
 * tokens/house-tokens.json. Do not edit; run the sync.
 *
 * The two grounds as hex, for the places that cannot read a CSS variable: a
 * web app manifest's theme_color and background_color, and the theme-color
 * metas a root layout declares.
 */

/** The dark ground, the kit's \`ink\` token. */
export const HOUSE_INK = "${hex("ink")}";

/** The light ground, the kit's \`paper\` token. */
export const HOUSE_PAPER = "${hex("paper")}";
`;
}

/** apps/web is a flat static site: assets sit beside index.html. */
function staticSurface(root, brand) {
  copy(`logo/svg/${brand}-favicon.svg`, `${root}/favicon.svg`);
  for (const size of [16, 32]) {
    copy(`icons/${brand}-icon-${size}.png`, `${root}/favicon-${size}.png`);
  }
  copy(`icons/${brand}-favicon.ico`, `${root}/favicon.ico`);
  copy(`icons/${brand}-icon-180.png`, `${root}/apple-touch-icon.png`);
  // Home-screen and installed-app icons: the same tiles the Next surfaces wear.
  for (const size of [192, 512]) {
    copy(`icons/${brand}-icon-${size}.png`, `${root}/icon-${size}.png`);
  }
  for (const size of MASKABLE) {
    copy(`icons/${brand}-icon-maskable-${size}.png`, `${root}/maskable-${size}.png`);
  }
  // The kit's web manifest, with paths rewritten for the flat static layout.
  const kitManifest = JSON.parse(
    readFileSync(join(BRAND, `icons/${brand}.webmanifest`), "utf8"),
  );
  emit(
    `${root}/${brand}.webmanifest`,
    `${JSON.stringify(
      {
        ...kitManifest,
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  // Launch screens, the install prompt, and the <head> block that lists
  // them: written into each hand-authored page between its pwa markers, and
  // exported for the blog's generated pages.
  for (const file of splashFiles(kitScreens(), brand)) {
    copy(`splash/${file}`, `${root}/splash/${file}`);
  }
  copy("pwa/install-prompt.js", `${root}/assets/install-prompt.js`);
  const block = staticPwaHead(startupImages(kitScreens(), brand, "/splash/"), {
    title: "Oxagen",
    script: "/assets/install-prompt.js",
    icon: "/icon-192.png",
  });
  for (const page of STATIC_PAGES) {
    const rel = `${root}/${page}`;
    emit(rel, withPwaHead(readFileSync(join(REPO, rel), "utf8"), block));
  }
  emit(
    `${root}/scripts/lib/pwa-head.generated.mjs`,
    `// GENERATED by tools/scripts/sync-brand-assets.mjs from the house kit's
// splash/ and pwa/. Do not edit; run the sync.

/** The launch-screen and install-prompt tags every page's <head> carries. */
export const PWA_HEAD = ${JSON.stringify(block)};
`,
  );
  copy(`social/${brand}-og-1200x630-dark.png`, `${root}/og.png`);
  copy(`logo/svg/${brand}-wordmark-adaptive.svg`, `${root}/assets/brand/${brand}-wordmark.svg`);
  copy(`logo/svg/${brand}-wordmark-dark.svg`, `${root}/assets/brand/${brand}-wordmark-on-dark.svg`);
  copy(`logo/svg/${brand}-icon-adaptive.svg`, `${root}/assets/brand/${brand}-icon.svg`);
  copy(`logo/svg/${brand}-icon-tile-dark.svg`, `${root}/assets/brand/${brand}-icon-tile-dark.svg`);
  copy(`spinners/${brand}-spinner.svg`, `${root}/assets/brand/${brand}-spinner.svg`);
  // The palette itself, so the static site references the kit's tokens rather
  // than a hand-transcribed copy of them. Its own stylesheet imports this file
  // and aliases onto it.
  copy("tokens/house-tokens.css", `${root}/assets/house-tokens.css`);
  // The static site serves its faces from /fonts/: the kit's three, beside
  // whatever else the site ships there.
  for (const f of readdirSync(join(BRAND, "fonts"))) {
    if (f.endsWith(".woff2") || f.startsWith("LICENSE")) copy(`fonts/${f}`, `${root}/fonts/${f}`);
  }
}

/**
 * The branding skill stub. The skill itself lives in the kit, and the stub
 * tells an agent to read it from the kit's main branch, so this repo carries
 * one file and no copy that can drift (#4804). Every other file in the folder
 * is a leftover of the vendored copy this repo used to carry: a sync removes
 * it, and a check lists it.
 */
function skill() {
  const dir = ".claude/skills/oxagen-branding";
  copy("skills/stub/oxagen-branding/SKILL.md", `${dir}/SKILL.md`);
  for (const rel of filesUnder(dir, `${dir}/SKILL.md`)) {
    if (CHECK) {
      drifted.push({ kind: "extra", path: rel });
      continue;
    }
    rmSync(join(REPO, rel));
    removed.push(rel);
  }
  if (!CHECK) {
    // Drop the folders the removed files leave empty.
    for (const sub of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      if (sub.isDirectory() && filesUnder(`${dir}/${sub.name}`).length === 0) {
        rmSync(join(REPO, dir, sub.name), { recursive: true });
      }
    }
  }
}

/**
 * The three faces: Space Grotesk (display), Geist (text), Monaspace Neon (code).
 * One copy, in @oxagen/ui, imported by every app. `house-fonts.css` is the
 * kit's @font-face file with its paths moved from ../fonts/ to ./fonts/.
 */
function fonts() {
  const dir = "packages/ui/src/styles/fonts";
  for (const f of readdirSync(join(BRAND, "fonts"))) {
    if (f.endsWith(".woff2") || f.startsWith("LICENSE")) copy(`fonts/${f}`, `${dir}/${f}`);
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
 * app can write: the `--color-ox-*` theme entries, the shadcn and Base UI
 * semantic names, the tracking scale, and the twelve type utilities
 * (`text-m-*` for a page read once, `text-a-*` for a dashboard read all day).
 * It imports `house-tokens.css` from beside it, which is why `globals.css`
 * imports this file rather than both.
 */
function tokens(kit) {
  copy("tokens/house-tokens.css", "packages/ui/src/styles/house-tokens.css");
  copy("tokens/house-tokens.json", "packages/ui/src/styles/house-tokens.json");
  copy("tokens/house-tailwind.css", "packages/ui/src/styles/house-tailwind.css");
  emit("packages/ui/src/lib/house-grounds.ts", houseGroundsModule(kit.tokens));
}

/**
 * The `INK` palette apps/web's generated images draw with, as the kit's
 * tokens give it: each key of `INK_TOKENS` mapped to the hex of the token it
 * names. Throws when the kit has no such token, so a renamed token fails the
 * sync instead of writing `undefined`.
 *
 * @param {Record<string, unknown>} kitTokens
 * @param {Readonly<Record<string, string>>} [map]
 * @returns {Record<string, string>}
 */
export function expectedInk(kitTokens, map = INK_TOKENS) {
  const ink = {};
  for (const [key, token] of Object.entries(map)) {
    const hex = kitTokens[token];
    if (typeof hex !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      throw new Error(`house kit has no colour token "${token}" for INK.${key}`);
    }
    ink[key] = hex;
  }
  return ink;
}

/**
 * `theme.mjs`'s source with each `key: "#hex"` line inside `INK` set to the
 * hex in `ink`. Throws when a key has no such line, so the check cannot pass
 * over a palette it could not read.
 */
export function rewriteInk(src, ink) {
  const block = src.match(/export const INK = Object\.freeze\(\{[\s\S]*?\}\);/);
  if (!block) throw new Error("theme.mjs has no `export const INK` block");
  let body = block[0];
  for (const [key, hex] of Object.entries(ink)) {
    const line = new RegExp(`(\\n\\s*${key}:\\s*)"#[0-9A-Fa-f]{6}"`);
    if (!line.test(body)) throw new Error(`theme.mjs INK has no ${key} colour`);
    body = body.replace(line, `$1"${hex}"`);
  }
  return src.replace(block[0], body);
}

/**
 * The web art modules. apps/web draws its social cards and blog figures from
 * `INK` in `scripts/lib/theme.mjs`, so its values are written from the kit
 * tokens here, and `--check` reports the file when one has drifted (#3074).
 */
function webTheme(kit) {
  const path = "apps/web/scripts/lib/theme.mjs";
  emit(path, rewriteInk(readFileSync(join(REPO, path), "utf8"), expectedInk(kit.tokens)));
}

/**
 * The marks, as data, for the React components in @oxagen/ui.
 *
 * <img src="…"> cannot follow the app theme, and hand-copying path data into a
 * .tsx is the drift this script exists to prevent, so the geometry is
 * extracted from the kit's adaptive SVGs and written to a generated module the
 * components import. Every number in it came out of the kit's `build/marks.py`.
 *
 * Each wordmark is two paths: `letters`, which takes currentColor and so flips
 * with the theme, and `accent`, the one gold glyph (the `x` of oxagen, the
 * asterisk of stella). The hive keeps each outline and gold cell from the kit.
 */
function marks(kit) {
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
      const attr = (name) => attrs.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
      const stroked = attr("stroke") === "currentColor";
      const part = {
        d: attr("d"),
        role: stroked || attr("fill") === "currentColor" ? "ink" : "accent",
      };
      if (stroked) part.strokeWidth = Number(attr("stroke-width") ?? 1);
      if (attr("opacity")) part.opacity = Number(attr("opacity"));
      return part;
    });
    if (!parts.length) throw new Error(`no paths in ${brand}-icon-adaptive.svg`);
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

  emit(
    "packages/ui/src/components/brand-marks.generated.ts",
    `/**
 * GENERATED by tools/scripts/sync-brand-assets.mjs from the Oxagen house brand
 * kit. Do not edit; run the sync instead.
 *
 * The kit reproduces both wordmarks from Space Grotesk itself (weight 600, one
 * em, HarfBuzz spacing including kerning) and both icons from the same face, so
 * the marks and the product's running text are the same outlines. Editing a
 * path here would break that. Changing a mark means changing the kit.
 *
 * ONE GLYPH IS GOLD: the \`x\` in oxagen, the asterisk in stella. \`letters\`
 * renders in currentColor and flips with the theme. \`accent\` keeps the metal
 * in both themes, as the kit's own light and dark files do. The rule that gold
 * becomes its deep shade on paper governs words, not the mark.
 *
 * An icon is a list of parts. Stella's is the gold asterisk alone. Oxagen's is
 * the hive: cell outlines in currentColor (\`ink\`) and two cells in the gold
 * (\`accent\`), one at half strength. A mono tone paints every part one colour.
 */

/** The kit's gold, pinned. It marks identity, and it is never a surface or a state. */
export const BRAND_GOLD = "${kit.gold.hex}";

export interface WordmarkGeometry {
  /** The kit's own viewBox. Do not re-fit it. */
  readonly viewBox: string;
  /** Intrinsic width in viewBox units. Width follows height when sized. */
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
  /** \`ink\` takes currentColor, and \`accent\` takes the gold. */
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

/**
 * The desktop icons. This script cannot cut them, because the cut needs
 * rsvg-convert and the Tauri CLI, and the fan-out has neither. It compares the
 * stamp the cut left with the avatar it just synced instead. A write prints
 * the reason and still exits 0, so the fan-out opens its PR. That PR's check
 * then fails until someone cuts the icons on its branch.
 */
function desktopIcons() {
  const icons = new Map(
    filesUnder(DESKTOP_ICONS, DESKTOP_STAMP).map((rel) => [rel, committed(rel)]),
  );
  const reason = desktopIconDrift(
    committed(DESKTOP_STAMP)?.toString("utf8") ?? null,
    synced,
    icons,
  );
  if (!reason) return null;
  if (CHECK) drifted.push({ kind: "stale", path: DESKTOP_STAMP, why: reason });
  return reason;
}

/* ── run ─────────────────────────────────────────────────────────────────── */

const HOW_TO_FIX =
  "Run node tools/scripts/sync-brand-assets.mjs --brand <kit> and commit the result. " +
  "If the desktop icons are stale, also run pnpm --filter @oxagen/desktop icons.";

if (isEntrypoint(import.meta.url)) {
  for (const surface of Object.keys(SURFACE_MARKS)) {
    try {
      for (const file of readdirSync(join(REPO, surface))) {
        if (file.startsWith(".")) continue;
        assertSurfaceMark(`${surface}/${file}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  let kit;
  try {
    kit = JSON.parse(readFileSync(join(BRAND, "tokens/house-tokens.json"), "utf8"));
  } catch {
    console.error(
      `brand: FAILED. No house kit at ${BRAND}, so nothing was ${CHECK ? "checked" : "synced"}. ` +
        "Clone oxageninc/brand and pass --brand <dir>, or set OXAGEN_BRAND_KIT.",
    );
    process.exit(2);
  }

  skill();
  fonts();
  tokens(kit);
  webTheme(kit);
  marks(kit);
  nextSurface("apps/app/public", "oxagen");
  nextSurface("apps/docs/public", "oxagen");
  // The deprecated app still boots locally and in archive deploys, so its
  // public marks stay on the same kit as the live surfaces. It is not offered
  // for install, so it takes no launch screens or prompt.
  nextSurface("apps/app_deprecated/public", "oxagen", { pwa: false });
  splashModule("oxagen");
  nextAppIcon("apps/docs", "oxagen");
  nextAppIcon("apps/app_deprecated", "oxagen");
  staticSurface("apps/web", "oxagen");
  for (const app of ["apps/app", "apps/docs", "apps/app_deprecated"]) {
    reconcile(`${app}/public/favicon`);
    reconcile(`${app}/public/pwa`);
  }
  reconcile("apps/web/splash");
  // apps/web's root holds the pages and everything else beside its icons, so
  // only the names an icon takes are swept.
  reconcile("apps/web", {
    deep: false,
    only: /^(favicon-\d+\.png|icon-\d+\.png|maskable(-light)?-\d+\.png|apple-touch-icon.*\.png|favicon.*\.ico)$/,
  });
  const desktop = desktopIcons();

  const kitName = `brand kit ${kit.version} at ${BRAND}`;
  if (CHECK) {
    if (drifted.length) {
      console.error(`brand: ${drifted.length} file(s) out of step with ${kitName}:`);
      for (const d of drifted) {
        console.error(`  ${d.kind.padEnd(7)}  ${d.path}${d.why ? ` (${d.why})` : ""}`);
      }
      console.error(HOW_TO_FIX);
      process.exit(1);
    }
    console.log(`brand: ${synced.size} files match ${kitName}`);
  } else {
    console.log(
      written.length || removed.length
        ? `brand: wrote ${written.length} and removed ${removed.length} file(s) from ${kitName}`
        : `brand: already matches ${kitName}`,
    );
    if (desktop) {
      console.warn(
        `brand: the desktop icons are stale: ${desktop}. Run pnpm --filter @oxagen/desktop icons and commit the result.`,
      );
    }
  }
}
