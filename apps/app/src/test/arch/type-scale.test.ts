// INV-36 (ARCHITECTURE.md §4): every font size in the app comes from the type
// scale, and the scale follows one base. Mac set this on 2026-10-03 (#5256):
// the base app font size is 14px, a default and not a floor. Changing the base
// in the brand kit changes every size in the app. Smaller text uses `text-sm`
// and `text-xs`, larger text uses `text-lg` and up, and no font size is
// hard-coded anywhere.
//
// The scale is the mapping that applies to the app's stylesheet. The test
// follows `src/app/globals.css` and every stylesheet it imports, in cascade
// order, and reads each `--text-<step>` from their `@theme` blocks. A later
// block wins, as it does in Tailwind. So a brand sync that changes a synced
// file's mapping changes what this test reads.
//
// The test fails when:
// - a Tailwind text step used in the app or in packages/ui has no mapping;
// - a mapped step does not resolve, through the kit's tokens, to the kit's app
//   base (`--ox-a-base`) times a ratio;
// - the mapped steps are not in strictly increasing order, or `text-base` is
//   not the base itself;
// - a module sets a font size by hand: a size in square brackets, such as
//   `text-[13px]`, an inline `fontSize` or `font-size` with a number, or a
//   `font` shorthand with a size;
// - a stylesheet sets a `font-size`, a `font` shorthand, or a `--text-*` with
//   a number and a unit, a fallback inside `var()` included, or with a size
//   keyword such as `smaller`.
//
// A size the app computes, such as the avatar's initials (src/ui/avatar.tsx),
// is not a literal, so the scan does not read it. ALLOWED names the files
// where no token can reach the page, each with its reason.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR, listFiles, WHOLE_TREE_TIMEOUT_MS } from "./parse";

const RULE = "type-scale";
const SELF = "src/test/arch/type-scale.test.ts";
const PROBES = "src/test/arch/probes/";
const UI_SRC = "../../packages/ui/src";
const UI_STYLES = `${UI_SRC}/styles/`;
/** The stylesheet the app loads, which imports every other one. */
const ENTRY = "src/app/globals.css";
/** The kit's tokens, which the brand sync copies into packages/ui. */
const KIT = `${UI_STYLES}house-tokens.css`;
/** The kit's app base. Every app step is this token times a ratio. */
const BASE = "--ox-a-base";

/** Tailwind's text steps, smallest first. */
const STEPS = [
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
] as const;

/**
 * Files where a literal size stays, because no token reaches the page there.
 * The test fails when one of them no longer holds a literal.
 */
const ALLOWED: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: `${UI_SRC}/components/global-error.tsx`,
    why: "Next.js renders global-error outside the root layout, so no stylesheet and no token loads there.",
  },
  {
    file: "src/features/tools/oauth-callback.ts",
    why: "A standalone HTML page that the OAuth popup shows before it closes. No app stylesheet loads there.",
  },
  {
    file: `${UI_SRC}/lib/utils.test.ts`,
    why: "It tests how cn() merges an arbitrary size against a house size. It renders nothing.",
  },
];

/** A font size in square brackets in a class: `text-[13px]`, `md:text-[0.9em]`, `text-[length:12px]`. */
const BRACKET_SIZE =
  /(?<![\w-])text-\[(?:length:|size:)?-?\d*\.?\d+(?:px|rem|em|%)\]/g;

/** An inline size in a module: `fontSize: 12`, `fontSize={10.5}`, `fontSize: "12px"`, `font-size:12px`. */
const INLINE_SIZE =
  /\bfont(?:Size|-size)\s*[:=]\s*\{?\s*["'`]?-?\d*\.?\d+(?:px|rem|em|%)?(?![\w.])/g;

/** A `font` shorthand with a size in a module: `font: "15px Arial"`, `font:15px/1.5 Aeonik`. */
const INLINE_FONT =
  /(?<![\w-])font\s*:\s*["'`]?[^;"'`}]*?(?<![\w-])\d*\.?\d+(?:px|rem|em|%)/g;

/** A Tailwind text step in a class: `text-sm`, `md:text-lg`. */
const STEP_CLASS = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g;

/** A size declaration in a stylesheet: `font-size`, the `font` shorthand, or Tailwind's `--text-<step>`. */
const CSS_SIZE =
  /(^|[{;\s])(font-size|font|--text-[a-z0-9]+)\s*:\s*([^;{}]*)/g;

/** A number with a length unit. */
const LENGTH = /(?<![\w-])\d*\.?\d+(?:px|rem|em|%)/;

/** A font size keyword, absolute or relative. */
const SIZE_KEYWORD =
  /(?<![\w-])(?:xxx-large|xx-large|x-large|large|medium|small|x-small|xx-small|smaller|larger)(?![\w-])/;

type Hit = { readonly file: string; readonly line: number; readonly name: string };
type Step = (typeof STEPS)[number];
type Mapping = { readonly value: string; readonly lineHeight?: string; readonly file: string };

function read(file: string): string {
  return readFileSync(path.join(APP_DIR, file), "utf8");
}

/**
 * `text` with each comment blanked out and its newlines kept, so line numbers
 * still count. A `//` counts only after a space or a bracket, so the one in
 * `https://` is not a comment.
 */
function withoutComments(text: string, lineComments: boolean): string {
  const blank = (comment: string) => comment.replace(/[^\n]/g, " ");
  const out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!lineComments) return out;
  return out.replace(
    /(^|[\s;{}(),])(\/\/[^\n]*)/gm,
    (_, lead: string, comment: string) => lead + blank(comment),
  );
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function each(
  file: string,
  text: string,
  pattern: RegExp,
  name: string,
): Hit[] {
  return [...text.matchAll(pattern)].map((m) => ({
    file,
    line: lineOf(text, m.index),
    name,
  }));
}

/** One line per hit, `type-scale <file>:<line> <name>`, in line order, each line and name once. */
function report(hits: readonly Hit[]): string[] {
  const sorted = [...hits].sort((a, b) =>
    a.file === b.file
      ? a.line - b.line || a.name.localeCompare(b.name)
      : a.file.localeCompare(b.file),
  );
  return [
    ...new Set(
      sorted.map((hit) => `${RULE} ${hit.file}:${String(hit.line)} ${hit.name}`),
    ),
  ];
}

/* ── the scale that applies ─────────────────────────────────────────────── */

/**
 * Where a stylesheet import resolves, relative to APP_DIR. A package import
 * outside @oxagen/ui, such as `tailwindcss`, maps nothing of ours, so it
 * resolves to null. Tailwind's own steps are its stock sizes, and the test
 * counts a step that only Tailwind defines as unmapped.
 */
function resolveImport(spec: string, from: string): string | null {
  if (spec.startsWith("@oxagen/ui/styles/")) {
    return `${UI_STYLES}${spec.slice("@oxagen/ui/styles/".length)}`;
  }
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  }
  return null;
}

/**
 * Each `--text-<step>` and its line height from the `@theme` blocks of `file`
 * and the stylesheets it imports, in cascade order. A later declaration wins.
 * `seen` collects every stylesheet the walk read, in the order it read them.
 */
function themeMapping(
  file: string,
  into: Map<Step, Mapping> = new Map(),
  seen: string[] = [],
): Map<Step, Mapping> {
  if (seen.includes(file)) return into;
  seen.push(file);
  const css = withoutComments(read(file), false);
  const statement =
    /@import\s+["']([^"']+)["'][^;]*;|@theme(?:\s+inline)?\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(statement)) {
    if (m[1] !== undefined) {
      const target = resolveImport(m[1], file);
      if (target !== null) themeMapping(target, into, seen);
      continue;
    }
    const block = m[2] ?? "";
    for (const d of block.matchAll(
      /--text-([a-z0-9]+)(--line-height)?\s*:\s*([^;]+);/g,
    )) {
      const step = d[1] as Step;
      if (!STEPS.includes(step)) continue;
      const value = (d[3] ?? "").trim();
      const prior = into.get(step);
      into.set(
        step,
        d[2] === undefined
          ? { value, lineHeight: prior?.lineHeight, file }
          : { value: prior?.value ?? "", lineHeight: value, file },
      );
    }
  }
  return into;
}

/** The kit's `--ox-*` tokens, by name, from the synced house-tokens.css. */
function kitTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  const css = withoutComments(read(KIT), false);
  for (const m of css.matchAll(/(--ox-[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1] ?? "";
    if (!tokens.has(name)) tokens.set(name, (m[2] ?? "").trim());
  }
  return tokens;
}

/**
 * `value` with every `var()` replaced by the token it names, until none is
 * left. It also returns each token it passed through, so a caller can tell a
 * step that reaches the base from one that does not.
 */
function substitute(
  value: string,
  tokens: ReadonlyMap<string, string>,
): { readonly text: string; readonly via: ReadonlySet<string> } {
  const via = new Set<string>();
  let text = value;
  for (let depth = 0; depth < 16 && text.includes("var("); depth++) {
    text = text.replace(
      /var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g,
      (whole, name: string) => {
        via.add(name);
        const next = tokens.get(name);
        return next === undefined ? whole : `(${next})`;
      },
    );
  }
  return { text, via };
}

/**
 * The size of a CSS length expression in px at a 16px root. It reads numbers
 * in px and rem, `calc()`, the four operators and brackets. Anything else,
 * such as an unresolved `var()`, gives NaN.
 */
function evaluate(expression: string): number {
  const source = expression
    .replace(/calc\(/g, "(")
    .replace(/(\d*\.?\d+)rem\b/g, "($1*16)")
    .replace(/(\d*\.?\d+)px\b/g, "$1");
  const tokens = source.match(/\d*\.?\d+|[()+\-*/]|\S/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const factor = (): number => {
    const token = tokens[at++];
    if (token === "(") {
      const inner = sum();
      if (tokens[at++] !== ")") return Number.NaN;
      return inner;
    }
    if (token === "-") return -factor();
    return token !== undefined && /^\d*\.?\d+$/.test(token)
      ? Number(token)
      : Number.NaN;
  };
  const product = (): number => {
    let out = factor();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[at++];
      const right = factor();
      out = op === "*" ? out * right : out / right;
    }
    return out;
  };
  const sum = (): number => {
    let out = product();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[at++];
      const right = product();
      out = op === "+" ? out + right : out - right;
    }
    return out;
  };
  const result = sum();
  return at === tokens.length ? result : Number.NaN;
}

/** A step's size in px, and whether it reached the kit's base. */
function stepSize(
  value: string,
  tokens: ReadonlyMap<string, string>,
): { readonly px: number; readonly followsBase: boolean } {
  const { text, via } = substitute(value, tokens);
  return { px: evaluate(text), followsBase: via.has(BASE) };
}

/* ── the scans ──────────────────────────────────────────────────────────── */

/** Every size a module sets by hand, and every step it uses that the scale does not map. */
function moduleHits(file: string, mapped: ReadonlySet<string>): Hit[] {
  const code = withoutComments(read(file), true);
  const unmapped = [...code.matchAll(STEP_CLASS)]
    .filter((m) => !mapped.has(m[1] ?? ""))
    .map((m) => ({ file, line: lineOf(code, m.index), name: "unmapped-step" }));
  return [
    ...each(file, code, BRACKET_SIZE, "bracket-size"),
    ...each(file, code, INLINE_SIZE, "inline-size"),
    ...each(file, code, INLINE_FONT, "inline-size"),
    ...unmapped,
  ];
}

/** Every size a stylesheet sets by hand. */
function stylesheetHits(file: string): Hit[] {
  const css = withoutComments(read(file), false);
  return [...css.matchAll(CSS_SIZE)]
    .filter((m) => {
      const value = m[3] ?? "";
      return LENGTH.test(value) || SIZE_KEYWORD.test(value);
    })
    .map((m) => ({
      file,
      line: lineOf(css, m.index + (m[1] ?? "").length),
      name: "css-size",
    }));
}

/** Every module under the app's src/ and packages/ui's src/, but the probes and this test. Test files count. */
function modules(): string[] {
  return [...listFiles("src"), ...listFiles(UI_SRC)].filter(
    (file) =>
      /\.tsx?$/.test(file) && file !== SELF && !file.startsWith(PROBES),
  );
}

/**
 * Every stylesheet under the app's src/ but the probes, and packages/ui's own
 * globals.css. The files the brand sync writes (`house-*.css`) are the kit's,
 * and the scale test reads the mapping they carry.
 */
function stylesheets(): string[] {
  return [
    ...listFiles("src").filter(
      (file) => file.endsWith(".css") && !file.startsWith(PROBES),
    ),
    `${UI_STYLES}globals.css`,
  ];
}

const allowed = new Set(ALLOWED.map((entry) => entry.file));

/** The steps the app's stylesheet maps, smallest first. */
function mappedSteps(): Step[] {
  const mapping = themeMapping(ENTRY);
  return STEPS.filter((step) => (mapping.get(step)?.value ?? "") !== "");
}

describe("type scale: one base, every size from a token", () => {
  it("maps text-xs to text-3xl at least, and text-base to the kit's base", () => {
    const mapping = themeMapping(ENTRY);
    const tokens = kitTokens();
    expect(tokens.has(BASE)).toBe(true);
    for (const step of ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"] as const) {
      expect(mapping.get(step)?.value, `--text-${step}`).toBeTruthy();
    }
    const base = evaluate(substitute(`var(${BASE})`, tokens).text);
    expect(stepSize(mapping.get("base")?.value ?? "", tokens).px).toBeCloseTo(
      base,
      6,
    );
  });

  it("resolves every mapped step to the base times a ratio, smallest first", () => {
    const mapping = themeMapping(ENTRY);
    const tokens = kitTokens();
    const base = evaluate(substitute(`var(${BASE})`, tokens).text);
    // The same scale with the base doubled: a step that follows the base doubles too.
    const doubled = new Map(tokens).set(BASE, `calc(${String(base * 2)}px)`);
    const rows = mappedSteps().map((step) => {
      const value = mapping.get(step)?.value ?? "";
      const at = stepSize(value, tokens);
      return {
        step,
        px: at.px,
        followsBase: at.followsBase,
        ratio: stepSize(value, doubled).px / at.px,
        lineHeight: mapping.get(step)?.lineHeight ?? "",
      };
    });
    for (const row of rows) {
      expect(Number.isFinite(row.px), `--text-${row.step} resolves`).toBe(true);
      expect(row.followsBase, `--text-${row.step} reaches ${BASE}`).toBe(true);
      expect(row.ratio, `--text-${row.step} moves with the base`).toBeCloseTo(2, 6);
      expect(row.lineHeight, `--text-${row.step}--line-height`).not.toBe("");
      expect(LENGTH.test(row.lineHeight), `--text-${row.step}--line-height`).toBe(
        false,
      );
    }
    for (const [i, larger] of rows.entries()) {
      const smaller = rows[i - 1];
      if (smaller === undefined) continue;
      expect(
        larger.px,
        `--text-${smaller.step} is under --text-${larger.step}`,
      ).toBeGreaterThan(smaller.px);
    }
  });

  it("follows the stylesheet imports to the mapping that applies", () => {
    // The entry imports @oxagen/ui's globals.css, which imports the kit's
    // Tailwind layer, so the walk reads the files the brand sync writes.
    const seen: string[] = [];
    themeMapping(ENTRY, new Map(), seen);
    expect(seen[0]).toBe(ENTRY);
    expect(seen).toEqual(
      expect.arrayContaining([
        `${UI_STYLES}globals.css`,
        `${UI_STYLES}house-tailwind.css`,
      ]),
    );
    expect(resolveImport("@oxagen/ui/styles/globals.css", ENTRY)).toBe(
      `${UI_STYLES}globals.css`,
    );
    expect(resolveImport("../ui/phone.css", ENTRY)).toBe("src/ui/phone.css");
    expect(resolveImport("tailwindcss", ENTRY)).toBeNull();
  });

  it(
    "no module sets a font size by hand or uses a step the scale does not map",
    () => {
      const mapped = new Set<string>(mappedSteps());
      const hits = modules().flatMap((file) => moduleHits(file, mapped));
      expect(report(hits.filter((hit) => !allowed.has(hit.file)))).toEqual([]);
      for (const entry of ALLOWED) {
        expect(
          hits.some((hit) => hit.file === entry.file),
          `${entry.file} still holds a literal size`,
        ).toBe(true);
      }
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it(
    "no stylesheet sets a font size by hand",
    () => {
      const files = stylesheets();
      expect(files).toEqual(
        expect.arrayContaining([
          ENTRY,
          "src/ui/phone.css",
          "src/ui/transcript-skins.css",
        ]),
      );
      expect(report(files.flatMap(stylesheetHits))).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("the module scan reads the probe the way it reads a page", () => {
    const mapped = new Set<string>(["xs", "sm", "base", "lg", "xl", "2xl", "3xl"]);
    const raw = `${PROBES}type-scale/raw.tsx`;
    expect(report(moduleHits(raw, mapped))).toEqual([
      `${RULE} ${raw}:5 bracket-size`,
      `${RULE} ${raw}:6 bracket-size`,
      `${RULE} ${raw}:7 bracket-size`,
      `${RULE} ${raw}:8 bracket-size`,
      `${RULE} ${raw}:9 inline-size`,
      `${RULE} ${raw}:10 inline-size`,
      `${RULE} ${raw}:11 inline-size`,
      `${RULE} ${raw}:12 inline-size`,
      `${RULE} ${raw}:13 unmapped-step`,
    ]);
    expect(report(moduleHits(`${PROBES}type-scale/clean.tsx`, mapped))).toEqual(
      [],
    );
  });

  it("the stylesheet scan reads the probe the way it reads a page", () => {
    const raw = `${PROBES}type-scale/raw.css`;
    expect(report(stylesheetHits(raw))).toEqual([
      `${RULE} ${raw}:4 css-size`,
      `${RULE} ${raw}:5 css-size`,
      `${RULE} ${raw}:6 css-size`,
      `${RULE} ${raw}:7 css-size`,
      `${RULE} ${raw}:8 css-size`,
      `${RULE} ${raw}:9 css-size`,
      `${RULE} ${raw}:10 css-size`,
      `${RULE} ${raw}:11 css-size`,
    ]);
    expect(report(stylesheetHits(`${PROBES}type-scale/clean.css`))).toEqual(
      [],
    );
  });

  it("the size reader resolves a step through the kit's tokens", () => {
    const tokens = new Map([
      [BASE, "0.875rem"],
      ["--ox-a-body", `var(${BASE})`],
      ["--ox-a-micro", `calc(var(${BASE}) * 0.857143)`],
    ]);
    expect(stepSize("var(--ox-a-body)", tokens)).toEqual({ px: 14, followsBase: true });
    expect(stepSize("var(--ox-a-micro)", tokens).px).toBeCloseTo(12, 4);
    expect(stepSize(`calc(var(${BASE}) * 18 / 7)`, tokens).px).toBeCloseTo(36, 6);
    expect(stepSize("0.75rem", tokens)).toEqual({ px: 12, followsBase: false });
    expect(Number.isNaN(stepSize("var(--ox-a-missing)", tokens).px)).toBe(true);
  });
});
