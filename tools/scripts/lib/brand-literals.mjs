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

/**
 * The stylesheets the guard reads, each with the type scale its surface
 * uses: `m` (the marketing scale, `--ox-m-*`) or `a` (the app scale,
 * `--ox-a-*`).
 *
 * Left out on purpose:
 * - `apps/app/src/ui/transcript-skins.css`: each skin copies another
 *   product's terminal, so its sizes and corners are that product's.
 * - `apps/app_deprecated/`: the archived app, which publishes no page.
 * - `apps/desktop/src/styles.css`: the desktop app's window, not a web page.
 * - the files the sync writes (`house-*.css`): they are the kit's own.
 *
 * @type {readonly { path: string, scale: Scale }[]}
 */
export const GUARDED = [
  { path: "packages/ui/src/styles/globals.css", scale: "a" },
  { path: "apps/app/src/app/globals.css", scale: "a" },
  { path: "apps/app/src/ui/phone.css", scale: "a" },
  { path: "apps/docs/src/app/global.css", scale: "a" },
  { path: "apps/web/assets/oxagen.css", scale: "m" },
  { path: "apps/web/assets/blog.css", scale: "m" },
];

const BELOW_M_MICRO =
  "below the marketing scale's smallest step (--ox-m-micro, 14px): a label, chip, caption, or figure note";

/**
 * The literals each guarded file keeps, by property and value, with the
 * reason. `prop` is the property group: `border-radius`, `box-shadow`,
 * `font-size` (which also covers the `font` shorthand), or `width` (which
 * covers `max-width`, `width`, and a custom property named for a wrap).
 *
 * @type {Readonly<Record<string, readonly { prop: string, values: readonly string[], why: string }[]>>}
 */
export const KEEP = {
  "apps/app/src/app/globals.css": [
    {
      prop: "width",
      values: ["1500px"],
      why: "the app's workspace frame, wider than the website's --ox-wrap on purpose",
    },
    {
      prop: "font-size",
      values: ["13px", "10.5px"],
      why: "the v3 mockup's table density: a 13px cell and a 10.5px caps header, between the app scale's steps",
    },
    {
      prop: "box-shadow",
      values: ["0 0 14px 1px color-mix(in oklab, var(--gold) 45%, transparent)"],
      why: "the launcher's unread glow, an animated cue and not elevation",
    },
  ],
  "apps/app/src/ui/phone.css": [
    {
      prop: "font-size",
      values: ["16px"],
      why: "Safari's floor for an input, below which iOS zooms the page on focus",
    },
  ],
  "apps/docs/src/app/global.css": [
    {
      prop: "font-size",
      values: ["11px"],
      why: "a diagram's wire label, a step under the app scale's micro (12px)",
    },
    {
      prop: "box-shadow",
      values: ["0 0 8px color-mix(in oklch, var(--_ember-b) 80%, transparent)"],
      why: "the landing terminal's caret glow, an animated cue and not elevation",
    },
  ],
  "apps/web/assets/oxagen.css": [
    {
      prop: "font-size",
      values: ["10.5px", "11px", "11.5px", "12px", "12.5px", "13px", "13.5px"],
      why: BELOW_M_MICRO,
    },
  ],
  "apps/web/assets/blog.css": [
    {
      prop: "border-radius",
      values: ["1px"],
      why: "the rounded end of a 2px bar, below the kit's smallest corner",
    },
    {
      prop: "font-size",
      values: [
        "10.5px",
        "11px",
        "11.5px",
        "12px",
        "12.5px",
        "13px",
        "13.2px",
        "13.5px",
        "13.6px",
        "13.8px",
      ],
      why: BELOW_M_MICRO,
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
 * such as `--r-lg: 12px` is read as the corner it is.
 *
 * @param {string} prop
 * @returns {"border-radius" | "box-shadow" | "font-size" | "width" | null}
 */
export function groupOf(prop) {
  if (prop.startsWith("--")) {
    if (/radius|^--r(-[a-z]+)?$/.test(prop)) return "border-radius";
    if (/shadow/.test(prop)) return "box-shadow";
    if (/wrap/.test(prop)) return "width";
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
  const base = sizes.get("--ox-radius-base");
  if (base !== undefined) {
    for (const [, name, k] of tokensCss.matchAll(
      /(--ox-radius-[\w]+):\s*calc\(var\(--ox-radius-base\)\s*\*\s*(\d*\.?\d+)\)/g,
    )) {
      sizes.set(name, base * Number(k));
    }
  }
  for (const [, name, target] of tokensCss.matchAll(
    /(--ox-[\w-]+):\s*var\((--ox-[\w-]+)\)\s*;/g,
  )) {
    const size = sizes.get(target);
    if (size !== undefined) sizes.set(name, size);
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
const TYPE_STEPS = ["h1", "h2", "h3", "h4", "body", "micro"];

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
