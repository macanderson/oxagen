// INV-32 (ARCHITECTURE.md §4, ADR-132): the app's presentation is the roadmap
// mockup's, rule for rule. The design of record is `mockups/src/engine.css` in
// the roadmap repository; `src/ui/control-styles.ts`, `src/ui/table.tsx`,
// `src/ui/route-tabs.tsx`, `src/ui/badge.tsx` and `src/app/globals.css` carry
// its rules as recipes, each naming the rule it draws. This test holds those
// recipes to the rules that drifted between 2026-09-17 and 2026-09-20:
// gold that became ink, flat headers that became grey bands, an eyebrow that
// lost its colour, tiles and badges that each page drew its own way.
//
// Each assertion quotes the rule. A recipe changes with the rule, and this
// file changes with it; a recipe that changes without this file is the drift
// this test exists to name.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buttonPrimary,
  buttonSecondary,
  eyebrow,
  panel,
  panelFooter,
  panelHeader,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { tabLink } from "@/ui/route-tabs";
import { headCell } from "@/ui/table";
import { APP_DIR, listFiles, WHOLE_TREE_TIMEOUT_MS } from "./parse";

const RULE = "design-record";

function read(file: string): string {
  return readFileSync(path.join(APP_DIR, file), "utf8");
}

/** The light `:root` block of globals.css: from its opening to the `body` rule. */
function lightRoot(): string {
  const css = read("src/app/globals.css");
  const start = css.indexOf("  :root {");
  const end = css.indexOf("  body {");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

describe("design record: the recipes carry the mockup's rules", () => {
  it("`.btn.primary` is gold in the light theme too, not the kit's ink primary", () => {
    const root = lightRoot();
    expect(root).toMatch(/--button-primary-bg:\s*var\(--gold\)/);
    expect(root).toMatch(/--button-primary-fg:\s*var\(--on-gold\)/);
    expect(buttonPrimary).toContain("bg-button-primary-bg");
    expect(buttonPrimary).not.toMatch(/\bbg-primary\b/);
  });

  it("`.tab[aria-selected] { border-bottom-color: var(--gold) }`", () => {
    expect(lightRoot()).toMatch(/--tab-border-active:\s*var\(--gold\)/);
    expect(tabLink).toContain("aria-[current=page]:border-gold");
    expect(tabLink).not.toContain("border-foreground");
  });

  it("`.eyebrow { color: var(--accent-text); text-transform: uppercase }`", () => {
    expect(eyebrow).toContain("text-accent-text");
    expect(eyebrow).toContain("uppercase");
  });

  it("`.panel-h` sits on the panel-head band; the footer and `th` stay flat on the panel", () => {
    expect(panelHeader).toContain("bg-panel-head");
    for (const recipe of [panelHeader, panelFooter, headCell]) {
      expect(recipe).not.toMatch(/\bbg-(data-surface|muted|hl|accent)\b/);
    }
    for (const recipe of [panelFooter, headCell]) {
      expect(recipe).not.toContain("bg-panel-head");
    }
    // ADR-170: light grey on paper, and on ink a step between the panel and
    // the row wash, so the band never matches a hovered row.
    expect(lightRoot()).toMatch(/--panel-head:\s*var\(--ox-paper-hl\)/);
    const css = read("src/app/globals.css");
    expect(
      css.match(
        /--panel-head:\s*color-mix\(in oklab, var\(--ox-panel\) 45%, var\(--ox-hl\)\)/g,
      ),
    ).toHaveLength(2);
    const th = css.match(/\[data-shell-page\] table thead th \{[^}]*\}/)?.[0];
    expect(th).toBeDefined();
    expect(th).toMatch(/background:\s*var\(--panel\)/);
    expect(th).toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/\[data-shell-page\] table \{[^}]*background/);
  });

  it("the dark theme's page body is the ink, and the panel grey stays on panels", () => {
    const css = read("src/app/globals.css");
    // The `.dark` block and the no-JS `prefers-color-scheme` copy of it.
    expect(css.match(/--app-panel-bg:\s*var\(--ink\)/g)).toHaveLength(2);
    expect(css).toMatch(/--ink:\s*var\(--background\)/);
  });

  it("`.panel` and `.stat` sit on the panel fill with the hairline and 12px corners", () => {
    for (const recipe of [panel, statTile]) {
      expect(recipe).toContain("bg-card");
      expect(recipe).toContain("border-border");
      expect(recipe).toContain("rounded-xl");
    }
    expect(statTerm).toContain("uppercase");
    expect(statValue).toContain("tabular-nums");
  });

  it("`.btn` at rest is the panel fill", () => {
    expect(lightRoot()).toMatch(/--button-default-bg:\s*var\(--panel\)/);
    expect(buttonSecondary).toContain("bg-button-default-bg");
  });
});

/**
 * The ink fill the kit calls `primary` has no rule in the mockup: an
 * identity fill is the gold (`.av`, `.btn.primary`, the nav inset), a solid
 * avatar is the ink itself (`.avx.tn-solid`, `bg-foreground`), and every
 * other fill is a wash or a state hue. A `bg-primary` under src/ is the drift
 * this file names, whichever way it drifted.
 */
const INK_PRIMARY =
  /\b(bg|text|border|ring|shadow-\[inset[^\]]*)-primary\b|var\(--primary\)/;

/** A tile drawn by hand instead of from `statTile`. */
const HAND_TILE = /rounded-xl border border-border bg-(data-surface|muted)\b/;

const SELF = "src/test/arch/design-record.test.ts";
const RECIPES = new Set(["src/ui/control-styles.ts", "src/app/globals.css"]);

function hits(
  files: readonly string[],
  pattern: RegExp,
  name: string,
): string[] {
  const out: string[] = [];
  for (const file of files) {
    const lines = read(file).split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line))
        out.push(`${RULE} ${file}:${String(index + 1)} ${name}`);
    });
  }
  return out;
}

/** Every production module and stylesheet under src/, but the recipes and this test. */
function scanned(): string[] {
  return listFiles("src").filter(
    (file) =>
      file !== SELF &&
      !RECIPES.has(file) &&
      !file.startsWith("src/test/") &&
      !/\.test\.tsx?$/.test(file) &&
      /\.(tsx?|css)$/.test(file),
  );
}

describe("design record: no page draws around the recipes", () => {
  it(
    "no file under src/ paints with the kit's ink primary",
    () => {
      expect(hits(scanned(), INK_PRIMARY, "ink-primary")).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it(
    "no file under src/ draws a stat tile by hand",
    () => {
      expect(hits(scanned(), HAND_TILE, "hand-tile")).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it(
    "every app page names its scope in an eyebrow over the h1 (`.phead .eyebrow`)",
    () => {
      const pages = listFiles("src/app/[org]").filter(
        (file) =>
          file.endsWith("/page.tsx") && read(file).includes("<PageHeader"),
      );
      expect(pages.length).toBeGreaterThan(0);
      const bare = pages.filter(
        (file) => !/<PageHeader[\s\S]*?eyebrow=/.test(read(file)),
      );
      expect(bare).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("the scan reads the probe the way it reads a page", () => {
    expect(
      hits(
        ["src/test/arch/probes/design-record/ink.tsx"],
        INK_PRIMARY,
        "ink-primary",
      ),
    ).toEqual([
      `${RULE} src/test/arch/probes/design-record/ink.tsx:3 ink-primary`,
    ]);
    expect(
      hits(
        ["src/test/arch/probes/design-record/clean.tsx"],
        INK_PRIMARY,
        "ink-primary",
      ),
    ).toEqual([]);
    expect(
      hits(
        ["src/test/arch/probes/design-record/clean.tsx"],
        HAND_TILE,
        "hand-tile",
      ),
    ).toEqual([]);
  });
});
