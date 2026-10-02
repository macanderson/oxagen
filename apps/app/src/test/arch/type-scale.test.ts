// INV-36 (ARCHITECTURE.md §4): no text in the app is smaller than 14px, and no
// class sets a font size of its own. Mac set both rules on 2026-10-02: "The
// minimum font size in the app has to be 14px at least! Not 13px! And we
// can't hard code font sizes in classes, we need to let the tokens do their
// job."
//
// A size reaches text through a token. `src/app/globals.css` maps Tailwind's
// `text-sm` to `--ox-a-body`, the house body step (14px). `text-xs` keeps its
// name and reads the same token, so it renders at the floor too. The larger
// Tailwind steps, `text-base` and up, all sit above the floor.
//
// The test fails on:
// - a font size in square brackets in a class, such as `text-[13px]`, at any
//   value, because the size belongs to a token;
// - the app scale's micro step (`text-a-micro`, `--ox-a-micro`), which is 12px;
// - a font size under 14px in a stylesheet under src/, including a fallback
//   inside `var()`;
// - an inline `fontSize` or `font-size` under 14px in a module;
// - a globals.css that no longer maps `--text-xs` and `--text-sm` to the body
//   token, or a kit whose body step drops under 14px.
//
// Two sizes are not literals, so the scan does not read them. The avatar's
// initials (src/ui/avatar.tsx) are computed from the avatar's size, as part of
// a picture. The Run page's waterfall (src/features/run/waterfall.tsx) sets
// its SVG labels with `text-sm`, in the chart's own units, and never draws the
// chart narrower than those units, so a label never renders under 14px.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR, listFiles, WHOLE_TREE_TIMEOUT_MS } from "./parse";

const RULE = "type-scale";
const SELF = "src/test/arch/type-scale.test.ts";
const PROBES = "src/test/arch/probes/";
/** The floor in px: the house body step, `--ox-a-body`. */
const FLOOR_PX = 14;

/** A font size in square brackets in a class: `text-[13px]`, `md:text-[0.9em]`, `text-[length:12px]`. */
const BRACKET_SIZE =
  /(?<![\w-])text-\[(?:length:|size:)?-?\d*\.?\d+(?:px|rem|em|%)\]/g;

/** The app scale's micro step, 12px: its class and its token. */
const MICRO_STEP = /(?<![\w-])text-a-micro(?![\w-])|--ox-a-micro(?![\w-])/g;

/** An inline size in a module: `fontSize: 12`, `fontSize={10.5}`, `fontSize: "12px"`, `font-size:12px`. */
const INLINE_SIZE =
  /\bfont(?:Size|-size)\s*[:=]\s*\{?\s*["'`]?(\d*\.?\d+)(px|rem|em|%)?(?![\w.])/g;

/** A size declaration in a stylesheet: `font-size`, or Tailwind's `--text-<step>`. */
const CSS_SIZE = /(^|[{;\s])(font-size|--text-[a-z0-9]+)\s*:\s*([^;{}]*)/g;

/** A size keyword under the parent's size. */
const SMALL_KEYWORD =
  /(?<![\w-])(?:smaller|small|x-small|xx-small|xxx-small)(?![\w-])/;

type Hit = { readonly file: string; readonly line: number; readonly name: string };

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

/** Whether a size is under the floor: px or rem under 14px, em under 1, a percentage under 100. */
function underFloor(n: number, unit: string): boolean {
  switch (unit) {
    case "":
    case "px":
      return n < FLOOR_PX;
    case "rem":
      return n * 16 < FLOOR_PX;
    case "em":
      return n < 1;
    case "%":
      return n < 100;
    default:
      return false;
  }
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

/** Every size a module sets by hand. */
function moduleHits(file: string): Hit[] {
  const text = read(file);
  const code = withoutComments(text, true);
  const inline = [...code.matchAll(INLINE_SIZE)]
    .filter((m) => underFloor(Number(m[1]), m[2] ?? ""))
    .map((m) => ({ file, line: lineOf(code, m.index), name: "inline-size" }));
  return [
    ...each(file, text, BRACKET_SIZE, "bracket-size"),
    ...each(file, code, MICRO_STEP, "micro-step"),
    ...inline,
  ];
}

/** Every size under the floor in a stylesheet. */
function stylesheetHits(file: string): Hit[] {
  const css = withoutComments(read(file), false);
  const sizes = [...css.matchAll(CSS_SIZE)]
    .filter((m) => {
      const value = m[3] ?? "";
      return (
        SMALL_KEYWORD.test(value) ||
        [...value.matchAll(/(-?\d*\.?\d+)(px|rem|em|%)/g)].some(
          ([, n, unit]) => underFloor(Number(n), unit ?? ""),
        )
      );
    })
    .map((m) => ({
      file,
      line: lineOf(css, m.index + (m[1] ?? "").length),
      name: "css-size",
    }));
  return [...sizes, ...each(file, css, MICRO_STEP, "micro-step")];
}

/** Every module under src/ but the probes and this test. Test files count. */
function modules(): string[] {
  return listFiles("src").filter(
    (file) =>
      /\.tsx?$/.test(file) && file !== SELF && !file.startsWith(PROBES),
  );
}

/** Every stylesheet under src/ but the probes. */
function stylesheets(): string[] {
  return listFiles("src").filter(
    (file) => file.endsWith(".css") && !file.startsWith(PROBES),
  );
}

describe("type scale: the 14px floor and token-only sizes", () => {
  it("globals.css maps text-xs and text-sm to the body token, and the body token is at least 14px", () => {
    const css = read("src/app/globals.css");
    const theme = css.match(/@theme inline \{[\s\S]*?\n\}/)?.[0];
    expect(theme).toBeDefined();
    expect(theme).toMatch(/--text-xs:\s*var\(--ox-a-body\);/);
    expect(theme).toMatch(
      /--text-xs--line-height:\s*var\(--text-sm--line-height\);/,
    );
    expect(theme).toMatch(/--text-sm:\s*var\(--ox-a-body\);/);
    const kit = readFileSync(
      path.join(APP_DIR, "../../packages/ui/src/styles/house-tokens.css"),
      "utf8",
    );
    const body = kit.match(/--ox-a-body:\s*(\d*\.?\d+)(rem|px)\s*;/);
    expect(body).not.toBeNull();
    const px = Number(body?.[1]) * (body?.[2] === "rem" ? 16 : 1);
    expect(px).toBeGreaterThanOrEqual(FLOOR_PX);
  });

  it(
    "no module under src/ sizes text in brackets, takes the micro step, or sets an inline size under 14px",
    () => {
      expect(report(modules().flatMap(moduleHits))).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("no stylesheet under src/ sets a size under 14px", () => {
    const files = stylesheets();
    expect(files).toEqual(
      expect.arrayContaining([
        "src/app/globals.css",
        "src/ui/phone.css",
        "src/ui/transcript-skins.css",
      ]),
    );
    expect(report(files.flatMap(stylesheetHits))).toEqual([]);
  });

  it("the module scan reads the probe the way it reads a page", () => {
    const raw = `${PROBES}type-scale/raw.tsx`;
    expect(report(moduleHits(raw))).toEqual([
      `${RULE} ${raw}:5 bracket-size`,
      `${RULE} ${raw}:6 bracket-size`,
      `${RULE} ${raw}:7 bracket-size`,
      `${RULE} ${raw}:8 bracket-size`,
      `${RULE} ${raw}:9 micro-step`,
      `${RULE} ${raw}:10 inline-size`,
      `${RULE} ${raw}:11 inline-size`,
      `${RULE} ${raw}:12 micro-step`,
    ]);
    expect(report(moduleHits(`${PROBES}type-scale/clean.tsx`))).toEqual([]);
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
      `${RULE} ${raw}:10 micro-step`,
    ]);
    expect(report(stylesheetHits(`${PROBES}type-scale/clean.css`))).toEqual(
      [],
    );
  });
});
