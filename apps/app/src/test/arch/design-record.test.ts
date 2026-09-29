// INV-32 (ARCHITECTURE.md §4, ADR-226): the app has two sources of record. The
// v3 mockup at the pin in ADR-226 (`mockups/src/v3.css` in oxagen-roadmap) sets
// layout and behavior. The brand kit (`macanderson/oxagen-brand`, synced into
// `packages/ui/src/styles/house-tokens.css`) sets tokens, type, and marks.
// `src/ui/control-styles.ts`, `src/ui/table.tsx`, `src/ui/route-tabs.tsx`,
// `src/ui/badge.tsx` and `src/app/globals.css` carry the rules as recipes.
// This test holds those recipes to the rules that drifted between 2026-09-17
// and 2026-09-20: gold that became ink, a header band that moved, an eyebrow
// that lost its colour, tiles and badges that each page drew its own way.
//
// It also fails when a file under src/ writes a colour or a font family the kit
// does not supply. A component draws with the kit's tokens, or it names its
// reason in the allowlist below.
//
// Each assertion quotes the v3 rule, or names the app's own rule where the app
// has not ported v3 yet. A recipe changes with the rule, and this file changes
// with it. A recipe that changes without this file is the drift this test
// exists to name.
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

  it("the two gold avatar tones have a fill and a glyph ink in both themes", () => {
    // `avatar.tsx` draws `bg-gold-deep text-on-gold-deep`. Tailwind emits
    // nothing for a colour the theme does not name, so without these a
    // gold-deep tile renders transparent while every component test passes.
    const css = read("src/app/globals.css");
    expect(css).toMatch(/--color-gold:\s*var\(--gold\)/);
    expect(css).toMatch(/--color-on-gold:\s*var\(--on-gold\)/);
    expect(css).toMatch(/--color-gold-deep:\s*var\(--gold-deep\)/);
    expect(css).toMatch(/--color-on-gold-deep:\s*var\(--on-gold-deep\)/);
    const root = lightRoot();
    expect(root).toMatch(/--gold-deep:\s*var\(--ox-gold-deep\)/);
    expect(root).toMatch(/--on-gold-deep:\s*var\(--ox-paper\)/);
  });

  it("the app's route tab underlines in gold (v3 keeps it for dialog tabs; ADR-226)", () => {
    // v3 draws page tabs as a muted track with a raised tab. Until a slice
    // ports that, the gold underline stays the app's rule for every tab row.
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
    // ADR-226: light grey on paper, and on ink a step between the panel and
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

  it("a body cell ends in an ellipsis (the app's rule from #4665; ADR-226)", () => {
    // #4665: no table text wraps, in a page or a dialog. The cap is per cell
    // through `--cell-max`, and a cell that spans columns keeps its own layout.
    // v3 draws no ellipsis on `td`, so this rule is the app's own.
    const css = read("src/app/globals.css");
    const td = css.match(
      /\n\s*table tbody :is\(td, th\):not\(\[colspan\]\) \{[^}]*\}/,
    )?.[0];
    expect(td).toBeDefined();
    expect(td).toMatch(/white-space:\s*nowrap/);
    expect(td).toMatch(/overflow:\s*hidden/);
    expect(td).toMatch(/text-overflow:\s*ellipsis/);
    expect(td).toMatch(/max-width:\s*var\(--cell-max,/);
  });

  it("the dark theme's page body is the ink, and the panel grey stays on panels", () => {
    const css = read("src/app/globals.css");
    // The `.dark` block and the no-JS `prefers-color-scheme` copy of it.
    expect(css.match(/--app-panel-bg:\s*var\(--ink\)/g)).toHaveLength(2);
    expect(css).toMatch(/--ink:\s*var\(--background\)/);
  });

  it("`.panel` and `.stat` sit on the panel fill with the hairline and the maia card corner", () => {
    // The corner is the preset's card (`rounded-2xl`, 13px at 0.45rem), which
    // replaced the mockup's 12px on 2026-09-28; globals.css sets the scale.
    for (const recipe of [panel, statTile]) {
      expect(recipe).toContain("bg-card");
      expect(recipe).toContain("border-border");
      expect(recipe).toContain("rounded-2xl");
    }
    const css = read("src/app/globals.css");
    expect(lightRoot()).toMatch(/--ui-radius:\s*0\.45rem/);
    expect(css).toMatch(/--radius-2xl:\s*calc\(var\(--radius\) \* 1\.8\)/);
    expect(css).toMatch(/--radius-4xl:\s*calc\(var\(--radius\) \* 2\.6\)/);
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
const HAND_TILE =
  /rounded-(xl|2xl) border border-border bg-(data-surface|muted)\b/;

/**
 * A colour the kit does not supply: a hex (one with a letter, or all digits
 * where a colour goes, so `"#4665"` stays an issue number), a colour function,
 * or a Tailwind default-palette class. The kit's colours reach a component as
 * a token (`bg-card`, `text-muted-foreground`, `var(--gold)`), never as a value.
 */
const RAW_COLOUR = new RegExp(
  [
    /(?<![\w&/#])#(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{3,8}(?![\w-])/,
    /(?:[:=]\s*["'`]?|\[)#(?:\d{8}|\d{6}|\d{3})(?![\w-])/,
    /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\bcolor\(\s*(?:srgb|display-p3)/,
    /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|accent|caret|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
    /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide)-(?:white|black)\b/,
  ]
    .map((part) => part.source)
    .join("|"),
);

/**
 * A font family the kit does not supply: a `font-family`, `fontFamily`, or
 * `font` shorthand that names a family instead of a `var(--…)` token, a
 * `font-serif` or `font-[…]` family class, `next/font`, or `@font-face`. The
 * kit's faces reach a component as `font-sans`, `font-display`, or `font-mono`.
 */
const RAW_FONT = new RegExp(
  [
    /font-family\s*:(?!\s*(?:var\(--|inherit\b))/,
    /fontFamily\s*:(?!\s*["'`]?var\(--)/,
    /\bfont\s*:\s*[^;{}"]*?(?:serif|monospace|system-ui|-apple-system)/,
    /\bfont-serif\b|\bfont-\[(?!\d|var\(|family-name:var\()/,
    /from\s+["']next\/font|@font-face/,
  ]
    .map((part) => part.source)
    .join("|"),
);

/**
 * The files that must write a literal colour, each with its reason (ADR-226).
 * A new entry carries its reason, and a stale entry fails the test below.
 */
const COLOUR_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    "src/app/layout.tsx",
    "`themeColor` metadata takes a value: the kit's ink and paper",
  ],
  ["src/app/manifest.ts", "the PWA manifest takes a value: the kit's ink"],
  [
    "src/features/auth/ui/oauth-buttons.tsx",
    "Google's mark, in Google's colours",
  ],
  [
    "src/features/tools/oauth-callback.ts",
    "a standalone HTML page that loads no stylesheet: the kit's ink and paper",
  ],
  [
    "src/ui/chart.tsx",
    "`[stroke='#ccc']` matches recharts' default grid and maps it to a token",
  ],
  [
    "src/ui/stella-mark.tsx",
    "the Stella mark's SVG fills: the kit's gold and its shimmer",
  ],
  [
    "src/ui/transcript-skins.css",
    "each harness skin copies its terminal's palette",
  ],
]);

/** The files that must write a literal font family, each with its reason. */
const FONT_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    "src/features/tools/oauth-callback.ts",
    "a standalone HTML page that loads no stylesheet: the kit's body stack",
  ],
  [
    "src/ui/avatar.tsx",
    "the avatar's serif option, which v3 draws as `.avx.f-serif`. The kit ships no serif",
  ],
  ["src/ui/avatar-editor.tsx", "the avatar's serif option, as in avatar.tsx"],
]);

const SELF = "src/test/arch/design-record.test.ts";
const RECIPES = new Set(["src/ui/control-styles.ts", "src/app/globals.css"]);

/** A line that is only a comment: `//`, `/*`, or a ` * ` continuation. */
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;

function hits(
  files: readonly string[],
  pattern: RegExp,
  name: string,
  { skipComments = false } = {},
): string[] {
  const out: string[] = [];
  for (const file of files) {
    const lines = read(file).split("\n");
    lines.forEach((line, index) => {
      if (skipComments && COMMENT_LINE.test(line)) return;
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
    "no file under src/ writes a colour the kit does not supply",
    () => {
      const files = scanned().filter((file) => !COLOUR_ALLOWED.has(file));
      expect(
        hits(files, RAW_COLOUR, "raw-colour", { skipComments: true }),
      ).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it(
    "no file under src/ writes a font family the kit does not supply",
    () => {
      const files = scanned().filter((file) => !FONT_ALLOWED.has(file));
      expect(
        hits(files, RAW_FONT, "raw-font", { skipComments: true }),
      ).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("every allowlisted file still writes the literal it is allowed", () => {
    const stale = [
      ...[...COLOUR_ALLOWED.keys()].filter(
        (file) =>
          hits([file], RAW_COLOUR, "raw-colour", { skipComments: true })
            .length === 0,
      ),
      ...[...FONT_ALLOWED.keys()].filter(
        (file) =>
          hits([file], RAW_FONT, "raw-font", { skipComments: true }).length ===
          0,
      ),
    ];
    expect(stale).toEqual([]);
  });

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

  it("the colour and font scans read the probe the way they read a page", () => {
    const raw = "src/test/arch/probes/design-record/raw.tsx";
    const clean = "src/test/arch/probes/design-record/clean.tsx";
    const scan = { skipComments: true };
    expect(hits([raw], RAW_COLOUR, "raw-colour", scan)).toEqual([
      `${RULE} ${raw}:4 raw-colour`,
      `${RULE} ${raw}:5 raw-colour`,
      `${RULE} ${raw}:6 raw-colour`,
    ]);
    expect(hits([raw], RAW_FONT, "raw-font", scan)).toEqual([
      `${RULE} ${raw}:7 raw-font`,
      `${RULE} ${raw}:8 raw-font`,
    ]);
    expect(hits([clean], RAW_COLOUR, "raw-colour", scan)).toEqual([]);
    expect(hits([clean], RAW_FONT, "raw-font", scan)).toEqual([]);
  });
});
