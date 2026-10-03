/**
 * The literal guard of the brand check (oxageninc/brand#63, #5104).
 *
 * Mac edits the house theme in one place, the kit's theme editor, and the
 * kit's fan-out syncs the tokens into this repo. A stylesheet that writes a
 * corner, a shadow, a font size, or a page wrap as a literal does not follow
 * that edit. This guard reads each stylesheet in GUARDED and lists every such
 * literal with its line and the token to use instead.
 *
 * It is a regex pass over a fixed list of files, with no build and no CSS
 * parser, so `sync-brand-assets.mjs --check` can run it on a bare runner.
 * The docs chrome's markup has a pass of its own (GUARDED_MARKUP), which
 * reads the classes a component writes. The two customer sites, oxagen.sh
 * and docs.oxagen.sh, have a type pass too (typeDrift, at the end of this
 * file), which holds them to the house type rule of oxageninc/brand#83.
 *
 * What passes without an entry:
 *
 * - any value that reads a token (`var(--…)`) and writes no length of its own;
 * - a corner of 0, a circle (50%), or a pill (999px, 9999px);
 * - a ring (a shadow with no offset and no blur, such as a focus ring) and an
 *   inset bar;
 * - a font size in em or percent, which is relative to its parent;
 * - a width under 1000px, which is a measure for text and not the page wrap.
 *
 * Everything else is named in KEEP, per file, with the reason it stays a
 * literal. An entry that no longer matches anything in its file is listed
 * too, so the allowlist cannot outlive the literal it excused.
 */

/** @typedef {"m" | "a"} Scale */
/** @typedef {"web" | "docs"} Site */

/**
 * The stylesheets the guard reads, each with the type scale its surface
 * uses: `m` (the marketing scale, `--ox-m-*`) or `a` (the app scale,
 * `--ox-a-*`).
 *
 * Left out on purpose:
 * - `apps/app/src/ui/transcript-skins.css`: each skin copies another
 *   product's terminal, so its corners are that product's. Its font sizes
 *   read the app scale's tokens, and `apps/app/src/test/arch/type-scale.test.ts`
 *   fails on a literal one.
 * - `apps/app_deprecated/`: the archived app, which publishes no page.
 * - `apps/desktop/src/styles.css`: the desktop app's window, not a web page.
 * - the files the sync writes (`house-*.css`): they are the kit's own.
 *
 * `site` marks a customer site's stylesheet, `web` for oxagen.sh and `docs`
 * for docs.oxagen.sh. The type pass at the end of this file holds those to
 * the house type rule as well (Mac, 2026-10-02, oxageninc/brand#83). `faces`
 * marks the stylesheet that must set h1 to h3 in Space Grotesk for its site,
 * and `with` lists the stylesheets a page always loads beside it, whose custom
 * properties it reads.
 *
 * @type {readonly { path: string, scale: Scale, site?: Site, faces?: boolean, with?: readonly string[] }[]}
 */
export const GUARDED = [
  { path: "packages/ui/src/styles/globals.css", scale: "a" },
  { path: "apps/app/src/app/globals.css", scale: "a" },
  { path: "apps/app/src/ui/phone.css", scale: "a" },
  { path: "apps/docs/src/app/global.css", scale: "a", site: "docs", faces: true },
  { path: "apps/web/assets/oxagen.css", scale: "m", site: "web", faces: true },
  {
    path: "apps/web/assets/blog.css",
    scale: "m",
    site: "web",
    with: ["apps/web/assets/oxagen.css"],
  },
  {
    path: "apps/web/assets/legal.css",
    scale: "m",
    site: "web",
    with: ["apps/web/assets/oxagen.css"],
  },
];

/**
 * The literals each guarded file keeps, by property and value, with the
 * reason. `prop` is the property group: `border-radius`, `box-shadow`,
 * `font-size` (which also covers the `font` shorthand), or `width` (which
 * covers `max-width`, `width`, and a custom property named for a wrap).
 *
 * @type {Readonly<Record<string, readonly { prop: string, values: readonly string[], why: string }[]>>}
 */
export const KEEP = {
  "apps/docs/src/app/global.css": [
    {
      prop: "box-shadow",
      values: ["0 0 8px color-mix(in oklch, var(--_ember-b) 80%, transparent)"],
      why: "the landing terminal's caret glow, an animated cue and not elevation",
    },
  ],
  "apps/web/assets/blog.css": [
    {
      prop: "border-radius",
      values: ["1px"],
      why: "the rounded end of a 2px bar, below the kit's smallest corner",
    },
  ],
};

/* ── reading the stylesheet ──────────────────────────────────────────────── */

/** `css` with each comment blanked out, newlines kept, so lines still count. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * Every declaration in `css` as `{ prop, value, line }`. A property counts
 * only at the start of a declaration, after `{`, `;`, or whitespace, so the
 * `max-width` inside `@media (max-width: 900px)` is never read as one.
 *
 * @param {string} css
 * @returns {{ prop: string, value: string, line: number }[]}
 */
export function declarations(css) {
  const text = stripComments(css);
  const out = [];
  const re = /(^|[{;\s])(--[\w-]+|[a-z][a-z-]*)\s*:\s*([^;{}]*)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = match.index + match[1].length;
    out.push({
      prop: match[2],
      value: match[3].replace(/\s+/g, " ").trim(),
      line: text.slice(0, start).split("\n").length,
    });
  }
  return out;
}

/**
 * The property group a declaration belongs to, or null when the guard does
 * not read it. A custom property joins a group by its name, so an alias
 * such as `--r-lg: 12px` is read as the corner it is. Tailwind's size for a
 * text class, such as `--text-sm`, is a font size: the docs set it so
 * Fumadocs' text classes read the app scale. Its `--text-sm--line-height`
 * twin is a ratio and is left alone. A step of a site's own type ramp,
 * such as oxagen.sh's `--fs-ui`, is a font size too.
 *
 * @param {string} prop
 * @returns {"border-radius" | "box-shadow" | "font-size" | "width" | null}
 */
export function groupOf(prop) {
  if (prop.startsWith("--")) {
    if (/radius|^--r(-[a-z]+)?$/.test(prop)) return "border-radius";
    if (/shadow/.test(prop)) return "box-shadow";
    if (/wrap/.test(prop)) return "width";
    if (/^--text-[a-z0-9]+$/.test(prop)) return "font-size";
    if (/^--fs-[a-z0-9-]+$/.test(prop)) return "font-size";
    return null;
  }
  if (/^border(-[a-z]+)*-radius$/.test(prop)) return "border-radius";
  if (prop === "box-shadow") return "box-shadow";
  if (prop === "font-size" || prop === "font") return "font-size";
  if (prop === "max-width" || prop === "width") return "width";
  return null;
}

/** `value` with every `var(…)` removed, nested ones included. */
export function withoutVars(value) {
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value.startsWith("var(", i)) {
      let depth = 0;
      let j = i + 3;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        else if (value[j] === ")" && --depth === 0) break;
      }
      i = j + 1;
      out += " ";
    } else {
      out += value[i++];
    }
  }
  return out;
}

/** The px and rem lengths in `text`, in pixels (16px to the rem). */
function lengthsPx(text) {
  return [...text.matchAll(/(-?\d*\.?\d+)(px|rem)\b/g)].map(
    ([, n, unit]) => Number(n) * (unit === "rem" ? 16 : 1),
  );
}

/** `value` split at its top-level commas, so `rgba(0, 0, 0)` stays whole. */
export function layers(value) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

const KEPT_CORNERS = new Set(["0", "0px", "50%", "999px", "9999px"]);

/**
 * Whether a shadow layer is a ring or an inset bar: an inset, or a shadow
 * whose offsets and blur are all zero (`0 0 0 2px <colour>`).
 */
function ringOrInset(layer) {
  if (/\binset\b/.test(layer)) return true;
  let bare = layer;
  while (/\([^()]*\)/.test(bare)) bare = bare.replace(/\([^()]*\)/g, "");
  const numbers = bare
    .split(/\s+/)
    .filter((part) => /^-?\d*\.?\d+(px|rem|em)?$/.test(part))
    .map((part) => Number.parseFloat(part));
  return numbers.length >= 3 && numbers.slice(0, 3).every((n) => n === 0);
}

/**
 * Whether a declaration's value writes a literal its group should take from
 * a token. `value` has `!important` removed.
 *
 * @param {"border-radius" | "box-shadow" | "font-size" | "width"} group
 * @param {string} value
 */
export function isLiteral(group, value) {
  const bare = withoutVars(value);
  switch (group) {
    case "border-radius":
      return bare
        .split(/[\s/(),]+/)
        .filter((part) => /^\d*\.?\d+(px|rem|em|%)$/.test(part))
        .some((part) => !KEPT_CORNERS.has(part));
    case "box-shadow":
      if (lengthsPx(bare).length === 0) return false;
      return layers(value).some(
        (layer) => lengthsPx(withoutVars(layer)).length > 0 && !ringOrInset(layer),
      );
    case "font-size":
      return lengthsPx(bare).length > 0;
    case "width":
      return lengthsPx(bare).some((px) => px >= 1000);
    default:
      return false;
  }
}

/* ── naming the token ────────────────────────────────────────────────────── */

/**
 * The kit's size tokens in pixels, read from the text of house-tokens.css:
 * every `--ox-*: <n>rem|px;`, every `calc(var(--ox-radius-base) * <k>)` step,
 * and every alias of one of those (`--ox-radius-card: var(--ox-radius-2xl)`).
 * A kit file the guard cannot read gives an empty map, and each suggestion
 * falls back to the token family's name.
 *
 * @param {string} tokensCss
 * @returns {Map<string, number>}
 */
export function tokenSizes(tokensCss) {
  const sizes = new Map();
  for (const [, name, n, unit] of tokensCss.matchAll(
    /(--ox-[\w-]+):\s*(\d*\.?\d+)(rem|px)\s*;/g,
  )) {
    sizes.set(name, Number(n) * (unit === "rem" ? 16 : 1));
  }
  // A step the kit writes as a multiple of a base, such as the radius steps
  // (`calc(var(--ox-radius-base) * 0.6)`) and, since oxageninc/brand#85, the
  // type steps (`calc(var(--ox-m-base) * 0.875)`), and an alias of a known
  // size (`--ox-m-body: var(--ox-m-base)`). A pass resolves what the last
  // one found, so a chain of them resolves too.
  const steps = [
    ...tokensCss.matchAll(/(--ox-[\w-]+):\s*calc\(var\((--ox-[\w-]+)\)\s*\*\s*(\d*\.?\d+)\)\s*;/g),
  ].map(([, name, base, k]) => [name, base, Number(k)]);
  const aliases = [...tokensCss.matchAll(/(--ox-[\w-]+):\s*var\((--ox-[\w-]+)\)\s*;/g)].map(
    ([, name, target]) => [name, target, 1],
  );
  for (let pass = 0; pass < 4; pass++) {
    for (const [name, base, k] of [...steps, ...aliases]) {
      const size = sizes.get(base);
      if (size !== undefined && !sizes.has(name)) sizes.set(name, size * k);
    }
  }
  return sizes;
}

/** The token in `names` whose size is nearest `px`, as `var(--…) (<n>px)`. */
function nearest(px, names, sizes, fallback) {
  let best = null;
  for (const name of names) {
    const size = sizes.get(name);
    if (size === undefined) continue;
    if (!best || Math.abs(size - px) < Math.abs(best.size - px)) best = { name, size };
  }
  if (!best || px === undefined) return fallback;
  return `var(${best.name}) (${Number(best.size.toFixed(2))}px)`;
}

const RADIUS_STEPS = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"].map(
  (step) => `--ox-radius-${step}`,
);
const TYPE_STEPS = ["h1", "h2", "h3", "h4", "body", "micro", "2xs"];

/**
 * What to write instead of a literal, for the guard's message.
 *
 * @param {"border-radius" | "box-shadow" | "font-size" | "width"} group
 * @param {string} value
 * @param {Scale} scale
 * @param {Map<string, number>} sizes
 */
export function suggestion(group, value, scale, sizes) {
  const px = lengthsPx(withoutVars(value)).find((n) => n > 0);
  switch (group) {
    case "border-radius": {
      // A website card is --ox-radius; a kit-style card is --ox-radius-card.
      const card = scale === "m" ? "--ox-radius" : "--ox-radius-card";
      return nearest(px, [card, ...RADIUS_STEPS], sizes, "a --ox-radius-* step");
    }
    case "box-shadow":
      return "var(--ox-shadow-pop) under a menu, popover, dialog, or toast, var(--ox-shadow-ui) under a control, or no shadow on a card at rest (the -ink twin on paper)";
    case "font-size":
      return nearest(
        px,
        TYPE_STEPS.map((step) => `--ox-${scale}-${step}`),
        sizes,
        `an --ox-${scale}-* step`,
      );
    default:
      return "var(--ox-wrap), or name a wider wrap in KEEP in tools/scripts/lib/brand-literals.mjs";
  }
}

/* ── the guard ───────────────────────────────────────────────────────────── */

/**
 * Every literal in the guarded files that should read a token, and every
 * KEEP entry that excuses nothing. A file whose text is null is skipped: the
 * tree test checks that each guarded file exists.
 *
 * @param {ReadonlyMap<string, string | null>} files repo path to text
 * @param {{ tokens?: string, guarded?: typeof GUARDED, keep?: typeof KEEP }} [options]
 * @returns {{
 *   hits: { path: string, line: number, prop: string, value: string, use: string }[],
 *   stale: { path: string, prop: string, value: string }[],
 * }}
 */
export function literalDrift(files, { tokens = "", guarded = GUARDED, keep = KEEP } = {}) {
  const sizes = tokenSizes(tokens);
  const hits = [];
  const stale = [];
  for (const { path, scale } of guarded) {
    const text = files.get(path);
    if (text === null || text === undefined) continue;
    const entries = keep[path] ?? [];
    const used = new Set();
    for (const { prop, value: raw, line } of declarations(text)) {
      const group = groupOf(prop);
      if (!group) continue;
      const value = raw.replace(/\s*!important$/, "");
      if (!isLiteral(group, value)) continue;
      const entry = entries.find((e) => e.prop === group && e.values.includes(value));
      if (entry) {
        used.add(`${group} ${value}`);
        continue;
      }
      hits.push({ path, line, prop, value, use: suggestion(group, value, scale, sizes) });
    }
    for (const entry of entries) {
      for (const value of entry.values) {
        if (!used.has(`${entry.prop} ${value}`)) stale.push({ path, prop: entry.prop, value });
      }
    }
  }
  return { hits, stale };
}

/* ── the docs markup ─────────────────────────────────────────────────────── */

/**
 * The docs chrome this app renders itself, held to the app scale.
 *
 * A Tailwind size class such as `text-sm` reads Tailwind's fixed size, so a
 * theme change in the kit reaches it only where a stylesheet maps that size
 * to a token. These components size their text with the kit's `text-a-*`
 * classes, which read the `--ox-a-*` tokens. The guard reads each file and
 * lists:
 *
 * - a Tailwind size class, from `text-xs` to `text-9xl`;
 * - a class on the other scale, such as `text-m-body` in an app-scale file;
 * - a size, corner, or shadow in square brackets that writes a length, such
 *   as `text-[15px]` or `rounded-[8px]`. These pass on the same terms as a
 *   stylesheet: a size in em or percent, a pill, a ring, and a token.
 *
 * A named `rounded-*` or `shadow-*` class passes, because @oxagen/ui maps
 * each one to a kit token. The pass is a regex over the source with its
 * comments blanked, the way Tailwind finds classes: it scans the text for
 * words shaped like a class and never runs the code.
 *
 * An entry marked `brackets` is held to the square-bracket rule only
 * (oxageninc/brand#83). These are the landing pages and the MDX components
 * of docs.oxagen.sh, which still size their headings with Tailwind's steps.
 * The kit points `text-xs` and `text-sm` at its own steps, so neither is a
 * size by hand.
 *
 * @type {readonly { path: string, scale: Scale, brackets?: boolean }[]}
 */
export const GUARDED_MARKUP = [
  { path: "apps/docs/src/app/docs/[[...slug]]/page.tsx", scale: "a" },
  { path: "apps/docs/src/components/docs/page-actions.tsx", scale: "a" },
  { path: "apps/docs/src/mdx-components.tsx", scale: "a" },
  { path: "apps/docs/src/components/docs/nav-title.tsx", scale: "a" },
  { path: "apps/docs/src/app/(home)/page.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/app/(home)/install/page.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/app/(home)/layout.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/components/landing/context-window.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/components/landing/copy-command.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/components/landing/hero-terminal.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/components/landing/install-terminal.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/components/landing/typewriter-terminal.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/components/mdx/latest-downloads.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/components/mdx/release-downloads.tsx", scale: "a", brackets: true },
  { path: "apps/docs/src/components/mdx/release-list.tsx", scale: "a", brackets: true },
];

/** The size in px of each Tailwind size class, from Tailwind's default theme. */
const TAILWIND_TEXT_PX = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 48,
  "6xl": 60,
  "7xl": 72,
  "8xl": 96,
  "9xl": 128,
};

/**
 * `src` with each comment blanked out, newlines kept. A line comment counts
 * only after a space or a bracket, so the `//` in `https://` is not one.
 */
export function stripMarkupComments(src) {
  const blank = (comment) => comment.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}(),])(\/\/[^\n]*)/gm, (_, lead, comment) => lead + blank(comment));
}

/**
 * The `text-<scale>-<step>` class nearest `px` on `scale`, with its size, or
 * the class family when the kit's sizes are unknown.
 */
function typeClass(px, scale, sizes) {
  let best = null;
  for (const step of TYPE_STEPS) {
    const size = sizes.get(`--ox-${scale}-${step}`);
    if (size === undefined) continue;
    if (!best || Math.abs(size - px) < Math.abs(best.size - px)) best = { step, size };
  }
  if (!best) return `a text-${scale}-* class`;
  return `text-${scale}-${best.step} (${Number(best.size.toFixed(2))}px)`;
}

/**
 * Every class in the guarded markup that sets a size, corner, or shadow by
 * hand, or that takes the other scale, as `{ path, line, prop, value, use }`.
 * `prop` is `class` and `value` is the class as written. A file whose text
 * is null is skipped: the tree test checks that each guarded file exists.
 *
 * @param {ReadonlyMap<string, string | null>} files repo path to text
 * @param {{ tokens?: string, guarded?: typeof GUARDED_MARKUP }} [options]
 * @returns {{ path: string, line: number, prop: string, value: string, use: string }[]}
 */
export function markupDrift(files, { tokens = "", guarded = GUARDED_MARKUP } = {}) {
  const sizes = tokenSizes(tokens);
  const hits = [];
  for (const { path, scale, brackets } of guarded) {
    const text = files.get(path);
    if (text === null || text === undefined) continue;
    const src = stripMarkupComments(text);
    const lineOf = (at) => src.slice(0, at).split("\n").length;
    const hit = (match, use) =>
      hits.push({ path, line: lineOf(match.index), prop: "class", value: match[0], use });

    if (!brackets) {
      for (const m of src.matchAll(/(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g)) {
        hit(m, typeClass(TAILWIND_TEXT_PX[m[1]], scale, sizes));
      }
      const other = scale === "a" ? "m" : "a";
      for (const m of src.matchAll(
        new RegExp(`(?<![\\w-])text-${other}-(h[1-4]|body|micro)(?![\\w-])`, "g"),
      )) {
        hit(m, `text-${scale}-${m[1]}, on this surface's own scale`);
      }
    }
    // A value in square brackets. Tailwind writes a space there as `_`.
    for (const m of src.matchAll(
      /(?<![\w-])(text|shadow|rounded(?:-(?:tl|tr|br|bl|ss|se|es|ee|[trblse]))?)-\[([^\]\s]+)\]/g,
    )) {
      const value = m[2].replace(/_/g, " ").replace(/^(?:length|size):/, "");
      const group = m[1] === "text" ? "font-size" : m[1] === "shadow" ? "box-shadow" : "border-radius";
      if (!isLiteral(group, value)) continue;
      hit(m, suggestion(group, value, scale, sizes));
    }
  }
  return hits;
}

/* ── the type rule on the customer sites ─────────────────────────────────── */

/**
 * The house type rule (Mac, 2026-10-02, oxageninc/brand#83), on the two
 * customer sites this repo publishes: oxagen.sh (`apps/web`) and
 * docs.oxagen.sh (`apps/docs`). Every size reads a step of the kit's scale,
 * and the steps follow the base, so a change to the base in the kit reaches
 * every size. The literal pass above already fails a font size written by
 * hand in a stylesheet. This pass adds what that pass cannot see:
 *
 * - the heading face: h1 to h3 on a customer site are set in Space Grotesk,
 *   the kit's display face, and a rule that points them at another face
 *   fails;
 * - a face named by hand: every `font-family` reads a kit token, so a page
 *   cannot set its code in the system's monospace instead of Monaspace Neon;
 * - the hand-written pages of oxagen.sh (GUARDED_PAGES), whose `<style>`
 *   blocks, `style` attributes, and script-drawn SVG text the literal pass
 *   does not read. A page keeps no size by hand, so it has no KEEP.
 *
 * The pass sets no smallest size. A small step below the base has real uses,
 * such as an eyebrow, a badge, or a table header, as long as it is a step.
 */

/**
 * The hand-written pages of oxagen.sh, each with its own `<style>` block.
 * `with` lists the guarded stylesheets a page links, whose custom properties
 * it reads. `faces` marks a page that links no site stylesheet and so sets
 * its own heading face.
 *
 * @type {readonly { path: string, scale: Scale, site: Site, with?: readonly string[], faces?: boolean }[]}
 */
export const GUARDED_PAGES = [
  { path: "apps/web/index.html", scale: "m", site: "web", with: ["apps/web/assets/oxagen.css"] },
  {
    path: "apps/web/products/oxagen/index.html",
    scale: "m",
    site: "web",
    with: ["apps/web/assets/oxagen.css"],
  },
  {
    path: "apps/web/privacy/index.html",
    scale: "m",
    site: "web",
    with: ["apps/web/assets/oxagen.css", "apps/web/assets/legal.css"],
  },
  {
    path: "apps/web/terms/index.html",
    scale: "m",
    site: "web",
    with: ["apps/web/assets/oxagen.css", "apps/web/assets/legal.css"],
  },
  { path: "apps/web/story/index.html", scale: "m", site: "web", faces: true },
  { path: "apps/web/read/index.html", scale: "m", site: "web", faces: true },
];

/** `text` with every character but a newline blanked, so lines still count. */
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

/**
 * What a page sets in CSS, by line.
 *
 * - `css`: the page with everything outside its `<style>` blocks blanked,
 *   so `declarations` and `rules` read it with the page's own line numbers.
 * - `inline`: each declaration in a `style` attribute, including one in an
 *   HTML string a script writes, and each SVG text size an attribute or a
 *   script sets (`font-size="11"`, `'font-size': 11`), read as px.
 *
 * @param {string} html
 * @returns {{ css: string, inline: { prop: string, value: string, line: number }[] }}
 */
export function pageCss(html) {
  // A <style> inside an inline <svg> belongs to that drawing, such as the
  // kit's wordmark, which colours itself for each scheme. It is art the kit
  // generates, so the page's own CSS leaves it out.
  const drawings = [...html.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)].map((m) => [
    m.index,
    m.index + m[0].length,
  ]);
  const inDrawing = (index) => drawings.some(([a, b]) => index >= a && index < b);
  let css = "";
  let at = 0;
  for (const m of html.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi)) {
    if (inDrawing(m.index)) continue;
    css += blank(html.slice(at, m.index + m[1].length)) + m[2];
    at = m.index + m[1].length + m[2].length;
  }
  css += blank(html.slice(at));
  const lineOf = (index) => html.slice(0, index).split("\n").length;
  const inline = [];
  for (const m of html.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/g)) {
    const start = m.index + m[0].indexOf(m[2]);
    for (const d of declarations(`{${m[2]}}`)) {
      inline.push({ ...d, line: lineOf(start) + d.line - 1 });
    }
  }
  for (const m of html.matchAll(
    /(?:\bfont-size\s*=\s*["']|["']font-size["']\s*:\s*["']?)(-?\d*\.?\d+)(px)?/g,
  )) {
    inline.push({ prop: "font-size", value: `${m[1]}px`, line: lineOf(m.index) });
  }
  return { css, inline };
}

/**
 * Every rule in `css` as `{ selector, body, line, bodyLine }`: the innermost
 * blocks only, so a rule inside `@media` is read with its own selector.
 * At-rules such as `@font-face` are left out. `line` is where the selector
 * starts and `bodyLine` where its `{` is.
 *
 * @param {string} css
 */
export function rules(css) {
  const text = stripComments(css);
  const out = [];
  for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = m[1].replace(/\s+/g, " ").trim();
    if (!selector || selector.startsWith("@")) continue;
    const lead = m[1].length - m[1].trimStart().length;
    const lineAt = (index) => text.slice(0, index).split("\n").length;
    out.push({
      selector,
      body: m[2],
      line: lineAt(m.index + lead),
      bodyLine: lineAt(m.index + m[1].length),
    });
  }
  return out;
}

/** `value` split at its top-level commas, or at its top-level spaces. */
function topLevel(value, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (sep === "," ? c === "," : /\s/.test(c))) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The headings among h1 to h3 a selector list styles: the type selector of
 * the last compound of each selector, so `.hero h1` and `h2.title` count, and
 * `h1 span` and `h2::before` (a pseudo-element, not the heading's text) do
 * not.
 *
 * @param {string} selector
 * @returns {Set<string>}
 */
export function headingsOf(selector) {
  const out = new Set();
  for (const one of topLevel(selector, ",")) {
    const last = one.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? "";
    if (last.includes("::")) continue;
    const m = /^(h[1-3])(?![\w-])/.exec(last);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * The size in a `font` shorthand: the value before its line height, or the
 * first length or function in it. Null when the shorthand names no size, as
 * in `font: inherit` or `font: var(--ox-font)`.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function shorthandSize(value) {
  const parts = topLevel(value, " ");
  const slash = parts.indexOf("/");
  if (slash > 0) return parts[slash - 1];
  for (const p of parts) {
    const at = slashAt(p);
    if (at > 0) return p.slice(0, at);
  }
  if (parts.length < 2) return null;
  return (
    parts.find(
      (p) => /^-?\d*\.?\d+(px|rem|em|%)$/.test(p) || /^(calc|clamp|min|max)\(/.test(p),
    ) ??
    parts.find((p) => /^var\(--(ox-[am]-|fs-|text-)/.test(p)) ??
    null
  );
}

/** The index of the first `/` outside parentheses in `text`, or -1. */
function slashAt(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "/" && depth === 0) return i;
  }
  return -1;
}

/**
 * The faces in a `font` shorthand: everything after its size and line
 * height. Null when the shorthand names no size.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function shorthandFamily(value) {
  const size = shorthandSize(value);
  if (size === null) return null;
  const parts = topLevel(value, " ");
  let i = parts.findIndex((p) => p === size || p.startsWith(`${size}/`));
  if (i < 0) return null;
  i += slashAt(parts[i]) > 0 ? 1 : parts[i + 1] === "/" ? 3 : 1;
  return parts.slice(i).join(" ") || null;
}

/**
 * Every custom property the given stylesheets set, as name to values, in
 * the order given.
 *
 * @param {readonly string[]} sheets
 * @returns {Map<string, string[]>}
 */
export function customProperties(sheets) {
  const vars = new Map();
  for (const css of sheets) {
    for (const { prop, value } of declarations(css)) {
      if (!prop.startsWith("--")) continue;
      const list = vars.get(prop) ?? [];
      list.push(value.replace(/\s*!important$/, ""));
      vars.set(prop, list);
    }
  }
  return vars;
}

/**
 * The faces that set a heading in Space Grotesk: the kit's display face,
 * `--ox-font-display` in its tokens and `--font-display` in its Tailwind
 * layer. A site may route h1 to h3 through a property of its own, such as
 * `--font-heading`, when that property reads one of these.
 */
const DISPLAY_FACES = ["--ox-font-display", "--font-display"];

/**
 * Whether a `font-family` value resolves to Space Grotesk. A custom property
 * the file's stylesheets set is followed, and every value it is given must
 * resolve. A property they do not set counts only when it is one of the
 * kit's display faces.
 *
 * @param {string} value
 * @param {ReadonlyMap<string, readonly string[]>} local
 * @returns {boolean}
 */
export function isDisplayFace(value, local, depth = 0) {
  const v = value.trim();
  if (depth > 8) return false;
  const m = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/.exec(v);
  if (!m) return /^["']?Space Grotesk["']?(\s*,|$)/.test(v);
  const values = local.get(m[1]);
  if (values && values.length) return values.every((x) => isDisplayFace(x, local, depth + 1));
  return DISPLAY_FACES.includes(m[1]);
}

/** Whether a `font-family` value names a face by hand instead of a token. */
function namesFace(value) {
  const v = value.trim();
  if (/^(inherit|initial|unset|revert|revert-layer)$/.test(v)) return false;
  return !/^var\(/.test(v);
}

/**
 * Every place a customer site breaks the type rule, as
 * `{ path, line, prop, value, use }`:
 *
 * - a font size written by hand in a page (a stylesheet's is the literal
 *   pass's to report);
 * - a `font-family` that names a face by hand, outside an `@font-face`;
 * - a rule for h1, h2, or h3 that sets a face other than Space Grotesk;
 * - a stylesheet or page marked `faces` that does not set all of h1 to h3
 *   in Space Grotesk.
 *
 * Only stylesheets with a `site` are read, because the app keeps its own
 * type rule (INV-36 in apps/app). A file whose text is null is skipped: the
 * tree test checks that each guarded file exists.
 *
 * @param {ReadonlyMap<string, string | null>} files repo path to text
 * @param {{ tokens?: string, guarded?: typeof GUARDED, pages?: typeof GUARDED_PAGES }} [options]
 * @returns {{ path: string, line: number, prop: string, value: string, use: string }[]}
 */
export function typeDrift(files, { tokens = "", guarded = GUARDED, pages = GUARDED_PAGES } = {}) {
  const sizes = tokenSizes(tokens);
  const sources = [];
  for (const g of guarded) {
    const text = files.get(g.path);
    if (!g.site || text === null || text === undefined) continue;
    sources.push({ ...g, page: false, css: text, inline: [] });
  }
  for (const p of pages) {
    const text = files.get(p.path);
    if (text === null || text === undefined) continue;
    sources.push({ ...p, page: true, ...pageCss(text) });
  }
  const cssOf = (path) => {
    const text = files.get(path);
    if (text === null || text === undefined) return "";
    return guarded.some((g) => g.path === path) ? text : pageCss(text).css;
  };

  const hits = [];
  for (const src of sources) {
    const { path, scale } = src;
    const linked = (src.with ?? []).map(cssOf);
    const local = customProperties([...linked, src.css]);
    const hit = (line, prop, value, use) => hits.push({ path, line, prop, value, use });

    const text = stripComments(src.css);
    const fontFaceLines = new Set();
    for (const m of text.matchAll(/@font-face\s*\{[^}]*\}/g)) {
      const first = text.slice(0, m.index).split("\n").length;
      const count = m[0].split("\n").length;
      for (let k = 0; k < count; k++) fontFaceLines.add(first + k);
    }

    for (const { prop, value: raw, line } of [...declarations(src.css), ...src.inline]) {
      const value = raw.replace(/\s*!important$/, "");
      if (src.page && groupOf(prop) === "font-size" && isLiteral("font-size", value)) {
        hit(line, prop, value, suggestion("font-size", value, scale, sizes));
        continue;
      }
      if ((prop === "font-family" || prop === "font") && !fontFaceLines.has(line)) {
        const family = prop === "font" ? shorthandFamily(value) : value;
        if (family !== null && namesFace(family)) {
          hit(
            line,
            prop,
            value,
            "a kit face: var(--ox-font) for text, var(--ox-font-mono) for code, or the site's alias of one",
          );
        }
      }
    }

    const set = new Set();
    for (const { selector, body, bodyLine } of rules(src.css)) {
      const heads = headingsOf(selector);
      if (!heads.size) continue;
      for (const d of declarations(`{${body}}`)) {
        if (d.prop !== "font-family" && d.prop !== "font") continue;
        const value = d.value.replace(/\s*!important$/, "");
        const family = d.prop === "font" ? shorthandFamily(value) : value;
        if (family === null || /^(inherit|initial|unset)$/.test(family.trim())) continue;
        if (isDisplayFace(family, local)) {
          const bare = topLevel(selector, ",");
          for (const h of heads) if (bare.includes(h)) set.add(h);
        } else {
          hit(
            bodyLine + d.line - 1,
            d.prop,
            value,
            `Space Grotesk on ${[...heads].join(", ")}: var(--ox-font-display), or the site's alias of it`,
          );
        }
      }
    }
    if (src.faces) {
      // A site on the kit's Tailwind layer can set the face the kit's way:
      // the layer sets h1 to h3 from --font-heading, and the site points that
      // property at the display face.
      const heading = local.get("--font-heading");
      if (heading?.length && heading.every((v) => isDisplayFace(v, local))) {
        for (const h of ["h1", "h2", "h3"]) set.add(h);
      }
      const missing = ["h1", "h2", "h3"].filter((h) => !set.has(h));
      if (missing.length) {
        hit(
          1,
          "font-family",
          "(none)",
          `a rule that sets ${missing.join(", ")} in Space Grotesk: h1, h2, h3 { font-family: var(--ox-font-display) }, or :root { --font-heading: var(--font-display) } on a site that loads the kit's Tailwind layer`,
        );
      }
    }
  }
  return hits;
}

/* ── the semantic rule on the customer sites ─────────────────────────────── */

/**
 * The semantic rule (Mac, 2026-10-03): on oxagen.sh and docs.oxagen.sh every
 * colour, corner, shadow, spacing value, and button reads a semantic token.
 * Raw kit tokens (`--ox-*`) are read in one place only, the token-mapping
 * layer, which is any custom property: `--panel: var(--ox-panel)` maps a raw
 * token to a role, and a rule then reads `var(--panel)`. This pass lists, on
 * each guarded stylesheet and page of the two sites:
 *
 * - a colour by hand (`#09090B`, `rgb()`, `hsl()`, `oklch()`, or a named
 *   colour) in a property that draws colour or in a custom property. A colour
 *   inside `url(…)` passes, because a data URI is an image;
 * - a raw `--ox-*` colour or shadow token read by a rule rather than mapped by
 *   a custom property. Raw type, space, corner, and wrap tokens pass: the
 *   rule reads those scales directly;
 * - a corner or shadow by hand in a page (a stylesheet's is the literal
 *   pass's);
 * - a spacing length by hand in `padding`, `margin`, or `gap`. `0`, a 1px
 *   hairline, `auto`, and a size in em, percent, or a viewport unit pass.
 *   Spacing reads `calc(var(--ox-space) * n)` or a property that does;
 * - a button (`.btn`, `.btn-*`) whose colours, border, or shadow read
 *   anything but the `--button-*` tokens.
 *
 * Generated art is left out: an inline SVG's own <style>, a data URI, the
 * docs' terminal drawings (`apps/docs/src/components/tui/`), and the install
 * page's confetti, which no stylesheet reaches.
 */

/** The properties that draw a colour. */
const COLOR_PROPS =
  /^(color|background|background-color|background-image|border|border-(top|right|bottom|left|block|inline)(-(start|end))?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-color|outline|outline-color|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration|text-decoration-color|column-rule|column-rule-color|stop-color|flood-color|lighting-color|-webkit-text-fill-color|-webkit-text-stroke|-webkit-text-stroke-color|scrollbar-color)$/;

/** The CSS colour keywords a page might write by hand. */
const NAMED_COLORS =
  /(?<![\w-])(white|black|red|green|blue|gray|grey|silver|maroon|purple|fuchsia|lime|olive|yellow|navy|teal|aqua|orange|pink|brown|gold|ivory|beige|tan|cyan|magenta|indigo|violet|crimson|coral|salmon|khaki|lavender|plum|orchid|tomato|wheat|snow|linen|azure)(?![\w-])/i;

/** `value` with every `url(…)` removed, so a data URI's colours pass. */
function withoutUrls(value) {
  return value.replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, "url()");
}

/** Whether `value` writes a colour by hand. */
export function colorLiteral(value) {
  const bare = withoutVars(withoutUrls(value));
  return (
    /#[0-9a-fA-F]{3,8}\b/.test(bare) ||
    /(?<![\w-])(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/.test(bare) ||
    NAMED_COLORS.test(bare)
  );
}

/**
 * The raw kit tokens a rule may read directly: the type, space, corner, and
 * wrap scales, the faces, and the weights. Every other `--ox-*` token is a
 * colour, a gradient, or a shadow, and a rule reads it through a role.
 */
const RAW_SCALES = /^--ox-(m-|a-|space|radius|wrap|font|weight|tracking|leading)/;

/** The raw colour or shadow tokens `value` reads, such as `--ox-panel`. */
export function rawColorTokens(value) {
  return [...value.matchAll(/var\(\s*(--ox-[\w-]+)/g)]
    .map((m) => m[1])
    .filter((name) => !RAW_SCALES.test(name));
}

/** The spacing properties: padding, margin, and gap, with their sides. */
const SPACING_PROPS =
  /^(padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap)$/;

/** Whether a spacing value writes a length by hand. */
export function spacingLiteral(value) {
  const bare = withoutVars(value);
  return [...bare.matchAll(/(-?\d*\.?\d+)(px|rem)\b/g)].some(
    ([, n, unit]) => !(unit === "px" && Math.abs(Number(n)) <= 1),
  );
}

/** Whether a selector styles a button: a `.btn` or `.btn-*` class. */
export function isButton(selector) {
  return /\.btn(?![\w])|\.btn-[\w-]+/.test(selector);
}

/** The values a button's colour may take besides a `--button-*` token. */
const BUTTON_FREE = /^(transparent|inherit|none|currentcolor|initial|unset|0)$/i;

/**
 * The stylesheets and pages of the two customer sites, as the semantic pass
 * reads them: GUARDED entries with a `site`, and GUARDED_PAGES.
 *
 * SEMANTIC_KEEP names each value a file keeps by hand, by property group and
 * value, with the reason, the way KEEP does for the literal pass. Keep it
 * short: every entry is a place a theme edit does not reach.
 *
 * @type {Readonly<Record<string, readonly { group: "color" | "raw" | "spacing" | "button" | "border-radius" | "box-shadow", values: readonly string[], why: string }[]>>}
 */
export const SEMANTIC_KEEP = {
  "apps/docs/src/app/global.css": [
    {
      group: "color",
      values: ["#fff", "1px solid #cbd5e1", "#111"],
      why: "the print stylesheet: a printed page is white paper with near-black ink and a visible code border whatever theme the screen used, and printers drop the theme's fills",
    },
  ],
  "apps/web/assets/legal.css": [
    {
      group: "color",
      values: ["#000"],
      why: "the print stylesheet: a printed policy is black ink on white paper whatever theme the screen used",
    },
  ],
  "apps/web/story/index.html": [
    {
      group: "color",
      values: ["#DD7E5E", "#70D0D0", "#4B83C4", "#BD2B4A", "#792400", "#3DA0A0", "#275F9E", "#C02F4D"],
      why: "the four work-area hues of the story's charts: each keeps the hue of a house state colour at a set lightness, tuned to stay apart under colour-vision deficiency on ink and on paper, and the kit has no stop for them",
    },
  ],
};

/**
 * Every place a customer site breaks the semantic rule, as
 * `{ path, line, prop, value, use }`, and every SEMANTIC_KEEP entry that
 * excuses nothing, as `{ path, group, value }`.
 *
 * @param {ReadonlyMap<string, string | null>} files repo path to text
 * @param {{ guarded?: typeof GUARDED, pages?: typeof GUARDED_PAGES, keep?: typeof SEMANTIC_KEEP }} [options]
 */
export function semanticDrift(
  files,
  { guarded = GUARDED, pages = GUARDED_PAGES, keep = SEMANTIC_KEEP } = {},
) {
  const sources = [];
  for (const g of guarded) {
    const text = files.get(g.path);
    if (!g.site || text === null || text === undefined) continue;
    sources.push({ path: g.path, page: false, css: text, inline: [] });
  }
  for (const p of pages) {
    const text = files.get(p.path);
    if (text === null || text === undefined) continue;
    sources.push({ path: p.path, page: true, ...pageCss(text) });
  }
  const hits = [];
  const stale = [];
  for (const { path, page, css, inline } of sources) {
    const entries = keep[path] ?? [];
    const used = new Set();
    const excused = (group, value) => {
      const entry = entries.find((e) => e.group === group && e.values.includes(value));
      if (entry) used.add(`${group} ${value}`);
      return Boolean(entry);
    };
    const hit = (line, prop, value, group, use) => {
      if (!excused(group, value)) hits.push({ path, line, prop, value, use });
    };

    // The selector of each declaration, for the button rule.
    const selectorAt = new Map();
    for (const r of rules(css)) {
      for (const d of declarations(`{${r.body}}`)) selectorAt.set(r.bodyLine + d.line - 1 + "|" + d.prop, r.selector);
    }

    for (const { prop, value: raw, line } of [...declarations(css), ...inline]) {
      const value = raw.replace(/\s*!important$/, "");
      const custom = prop.startsWith("--");
      if ((custom || COLOR_PROPS.test(prop)) && colorLiteral(value)) {
        hit(line, prop, value, "color", "a semantic colour token, mapped from the kit in a custom property");
        continue;
      }
      if (!custom) {
        const rawTokens = rawColorTokens(value);
        if (rawTokens.length) {
          hit(line, prop, value, "raw", `a role that maps ${rawTokens.join(", ")} in the token-mapping layer`);
          continue;
        }
      }
      if (SPACING_PROPS.test(prop) && spacingLiteral(value)) {
        hit(line, prop, value, "spacing", "calc(var(--ox-space) * n), where --ox-space is the kit's spacing unit");
        continue;
      }
      if (page) {
        const group = groupOf(prop);
        if ((group === "border-radius" || group === "box-shadow") && isLiteral(group, value)) {
          hit(line, prop, value, group, group === "border-radius" ? "a --ox-radius-* step, or the site's alias of one" : "var(--shadow-pop) or var(--shadow-ui), or none");
          continue;
        }
      }
      const selector = selectorAt.get(line + "|" + prop);
      if (selector && isButton(selector) && COLOR_PROPS.test(prop) && !BUTTON_FREE.test(value.trim())) {
        // A border such as `1px solid transparent` names no colour of its
        // own, so it passes. Anything that reads a token reads a button one.
        const reads = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
        if (reads.some((name) => !name.startsWith("--button-"))) {
          hit(line, prop, value, "button", "a --button-* token: a button takes its colours, border, and shadow from the button tokens only");
        }
      }
    }
    for (const entry of entries) {
      for (const value of entry.values) {
        if (!used.has(`${entry.group} ${value}`)) stale.push({ path, group: entry.group, value });
      }
    }
  }
  return { hits, stale };
}

/**
 * The colour and spacing classes the docs markup writes by hand: a Tailwind
 * palette class (`bg-zinc-800`, `text-white/40`), a colour in square brackets
 * (`text-[#57A97C]`, or a hex fallback inside `var()`), and a spacing length
 * in square brackets (`p-[13px]`). A class reading a semantic token, such as
 * `bg-primary` or `text-[var(--ember-ink)]`, passes.
 *
 * MARKUP_KEEP names each class a file keeps, with the reason.
 *
 * @type {Readonly<Record<string, readonly { values: readonly string[], why: string }[]>>}
 */
export const MARKUP_KEEP = {};

const PALETTE =
  "white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

/**
 * @param {ReadonlyMap<string, string | null>} files repo path to text
 * @param {{ guarded?: typeof GUARDED_MARKUP, keep?: typeof MARKUP_KEEP }} [options]
 */
export function markupSemanticDrift(files, { guarded = GUARDED_MARKUP, keep = MARKUP_KEEP } = {}) {
  const hits = [];
  const stale = [];
  for (const { path } of guarded) {
    const text = files.get(path);
    if (text === null || text === undefined) continue;
    const src = stripMarkupComments(text);
    const lineOf = (at) => src.slice(0, at).split("\n").length;
    const entries = keep[path] ?? [];
    const used = new Set();
    const hit = (m, use) => {
      const entry = entries.find((e) => e.values.includes(m[0]));
      if (entry) {
        used.add(m[0]);
        return;
      }
      hits.push({ path, line: lineOf(m.index), prop: "class", value: m[0], use });
    };
    for (const m of src.matchAll(
      new RegExp(
        `(?<![\\w-])(?:[a-z]+:)*(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|decoration|caret|accent|shadow|placeholder)-(?:${PALETTE})(?:-\\d{2,3})?(?:/\\d+)?(?![\\w-])`,
        "g",
      ),
    )) {
      hit(m, "a semantic colour class, such as text-foreground, text-muted-foreground, or bg-card");
    }
    // A colour by hand anywhere in the source: in a class in square
    // brackets, a style object, or an SVG attribute. Each is listed by the
    // run of text around it, so the line names what to change.
    for (const m of src.matchAll(/[^\s"'`{}]*(?:#[0-9a-fA-F]{3,8}\b|(?<![\w-])(?:rgba?|hsla?|oklch|oklab)\([^)]*\))[^\s"'`{}]*/g)) {
      if (/^&?#\d/.test(m[0]) || /^#[0-9]+$/.test(m[0])) continue; // an issue or entity number
      hit(m, "a semantic colour token, such as var(--success) or a class like bg-brand, with no fallback");
    }
    for (const m of src.matchAll(/(?<![\w-])(?:[a-z]+:)*[a-z-]+-\[[^\]\s]*\]/g)) {
      const inner = m[0].slice(m[0].indexOf("[") + 1, -1);
      const base = m[0].replace(/^(?:[a-z]+:)*/, "");
      if (
        /^-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-\[/.test(base) &&
        spacingLiteral(inner.replace(/_/g, " "))
      ) {
        hit(m, "a spacing step such as p-4, which reads the kit's --ox-space");
      }
    }
    for (const entry of entries) {
      for (const value of entry.values) if (!used.has(value)) stale.push({ path, value });
    }
  }
  return { hits, stale };
}
