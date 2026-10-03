// The literal guard of the brand check (oxageninc/brand#63, #5104). Every
// case here is a string, so the test reads no file. The tree test in
// sync-brand-assets.tree.test.ts runs the guard over the live stylesheets.
import { describe, expect, it } from "vitest";
import {
  GUARDED,
  GUARDED_MARKUP,
  GUARDED_PAGES,
  KEEP,
  customProperties,
  declarations,
  groupOf,
  headingsOf,
  isDisplayFace,
  isLiteral,
  layers,
  literalDrift,
  markupDrift,
  pageCss,
  rules,
  shorthandFamily,
  shorthandSize,
  stripComments,
  stripMarkupComments,
  suggestion,
  tokenSizes,
  typeDrift,
  withoutVars,
} from "./brand-literals.mjs";

/** The kit's size tokens, in the shape house-tokens.css writes them. */
const TOKENS = `
:root {
  --ox-m-h1: 4.5rem; /* 72px */
  --ox-m-h2: 2.5rem;
  --ox-m-h3: 1.75rem;
  --ox-m-h4: 1.25rem;
  --ox-m-body: 1.125rem;
  --ox-m-micro: 0.875rem;
  --ox-a-h1: 1.875rem;
  --ox-a-h2: 1.5rem;
  --ox-a-h3: 1.25rem;
  --ox-a-h4: 1rem;
  --ox-a-body: 0.875rem;
  --ox-a-micro: 0.75rem;
  --ox-radius: 0.75rem; /* 12px */
  --ox-wrap: 1120px;
  --ox-radius-base: 0.45rem;
  --ox-radius-xs: calc(var(--ox-radius-base) * 0.4);
  --ox-radius-sm: calc(var(--ox-radius-base) * 0.6);
  --ox-radius-md: calc(var(--ox-radius-base) * 0.8);
  --ox-radius-lg: calc(var(--ox-radius-base) * 1);
  --ox-radius-xl: calc(var(--ox-radius-base) * 1.4);
  --ox-radius-2xl: calc(var(--ox-radius-base) * 1.8);
  --ox-radius-3xl: calc(var(--ox-radius-base) * 2.2);
  --ox-radius-4xl: calc(var(--ox-radius-base) * 2.6);
  --ox-radius-card: var(--ox-radius-2xl);
}
`;

describe("reading a stylesheet", () => {
  it("blanks comments and keeps the line count", () => {
    const css = "a {\n  /* border-radius: 4px;\n  more */\n  color: red;\n}";
    const out = stripComments(css);
    expect(out).not.toContain("border-radius");
    expect(out.split("\n")).toHaveLength(css.split("\n").length);
  });

  it("finds each declaration with its line, and never a media query", () => {
    const css = [
      "@media (max-width: 900px) {",
      "  .a { max-width: 1200px; }",
      "}",
      ".b {",
      "  border-radius: 4px;",
      "  box-shadow:",
      "    0 1px 2px red,",
      "    0 0 0 1px blue;",
      "}",
    ].join("\n");
    expect(declarations(css)).toEqual([
      { prop: "max-width", value: "1200px", line: 2 },
      { prop: "border-radius", value: "4px", line: 5 },
      { prop: "box-shadow", value: "0 1px 2px red, 0 0 0 1px blue", line: 6 },
    ]);
  });

  it("reads a declaration that follows another on the same line", () => {
    expect(declarations(".a{font-size:12px;border-radius:2px}")).toEqual([
      { prop: "font-size", value: "12px", line: 1 },
      { prop: "border-radius", value: "2px", line: 1 },
    ]);
  });

  it("reads nothing out of a selector", () => {
    expect(
      declarations(".a:hover, :root:not(.dark) { color: red; }").filter(
        (d) => groupOf(d.prop) !== null,
      ),
    ).toEqual([]);
  });
});

describe("the property groups", () => {
  it.each([
    ["border-radius", "border-radius"],
    ["border-top-left-radius", "border-radius"],
    ["box-shadow", "box-shadow"],
    ["font-size", "font-size"],
    ["font", "font-size"],
    ["max-width", "width"],
    ["width", "width"],
    ["--r", "border-radius"],
    ["--r-lg", "border-radius"],
    ["--ui-radius", "border-radius"],
    ["--radius-2xl", "border-radius"],
    ["--ui-shadow", "box-shadow"],
    ["--shadow-pop", "box-shadow"],
    ["--page-wrap", "width"],
    ["--text-sm", "font-size"],
    ["--text-2xl", "font-size"],
    ["--fs-ui", "font-size"],
    ["--fs-micro", "font-size"],
  ])("reads %s as %s", (prop, group) => {
    expect(groupOf(prop)).toBe(group);
  });

  it.each([
    "color",
    "font-family",
    "font-weight",
    "line-height",
    "--side-w",
    "--rule",
    "--tex-hex",
    "--text-sm--line-height",
  ])(
    "leaves %s alone",
    (prop) => {
      expect(groupOf(prop)).toBeNull();
    },
  );
});

describe("what counts as a literal", () => {
  it("removes every var(), nested fallbacks included", () => {
    expect(withoutVars("var(--a, var(--b, 4px)) 2px").trim()).toBe("2px");
  });

  it("splits shadow layers at top-level commas only", () => {
    expect(layers("0 1px 2px rgba(0, 0, 0, 0.2), inset 0 0 0 1px red")).toEqual([
      "0 1px 2px rgba(0, 0, 0, 0.2)",
      "inset 0 0 0 1px red",
    ]);
  });

  it.each([
    "var(--ox-radius-lg)",
    "var(--ox-radius-4xl) var(--ox-radius-4xl) 0 0",
    "0",
    "50%",
    "999px",
    "9999px",
    "inherit",
  ])("passes the corner %s", (value) => {
    expect(isLiteral("border-radius", value)).toBe(false);
  });

  it.each(["8px", "0.5rem", "18px 18px 0 0", "calc(var(--radius) + 4px)", "max(0px, calc(var(--radius) - 4px))"])(
    "flags the corner %s",
    (value) => {
      expect(isLiteral("border-radius", value)).toBe(true);
    },
  );

  it.each([
    "var(--ox-shadow-pop)",
    "none",
    "0 0 0 2px color-mix(in oklch, var(--ring) 25%, transparent)",
    "0 0 0 1px var(--gold)",
    "inset 4px 0 0 var(--ink)",
    "0 0 0 0 transparent",
  ])("passes the shadow %s (a token, a ring, or a bar)", (value) => {
    expect(isLiteral("box-shadow", value)).toBe(false);
  });

  it.each([
    "0 1px 2px rgba(0, 0, 0, 0.25)",
    "0 0 14px 1px color-mix(in oklab, var(--gold) 45%, transparent)",
    "0 1px 0 0 rgba(255, 255, 255, 0.06) inset, 0 18px 50px -30px rgba(0, 0, 0, 0.7)",
  ])("flags the shadow %s", (value) => {
    expect(isLiteral("box-shadow", value)).toBe(true);
  });

  it.each([
    "var(--ox-m-body)",
    "clamp(var(--ox-m-h3), 4.2vw, var(--ox-m-h1))",
    "0.8em",
    "inherit",
    "400 var(--ox-m-body) / var(--ox-m-body-leading) var(--font-sans)",
  ])("passes the font size %s", (value) => {
    expect(isLiteral("font-size", value)).toBe(false);
  });

  it.each(["14px", "0.75rem", "clamp(29px, 4.2vw, 44px)", "400 16px / 1.62 var(--font-sans)"])(
    "flags the font size %s",
    (value) => {
      expect(isLiteral("font-size", value)).toBe(true);
    },
  );

  it("flags a page-wide width and passes a text measure", () => {
    expect(isLiteral("width", "1500px")).toBe(true);
    expect(isLiteral("width", "min(1180px, calc(100% - 40px))")).toBe(true);
    expect(isLiteral("width", "min(var(--ox-wrap), calc(100% - 40px))")).toBe(false);
    expect(isLiteral("width", "740px")).toBe(false);
    expect(isLiteral("width", "var(--cell-max, 20rem)")).toBe(false);
    expect(isLiteral("width", "62ch")).toBe(false);
  });

  it("reads no other group", () => {
    expect(isLiteral("color" as never, "12px")).toBe(false);
  });
});

describe("naming the token", () => {
  const sizes = tokenSizes(TOKENS);

  it("reads rem and px tokens, the radius steps, and their aliases", () => {
    expect(sizes.get("--ox-m-micro")).toBe(14);
    expect(sizes.get("--ox-wrap")).toBe(1120);
    expect(sizes.get("--ox-radius-lg")).toBeCloseTo(7.2);
    expect(sizes.get("--ox-radius-4xl")).toBeCloseTo(18.72);
    expect(sizes.get("--ox-radius-card")).toBeCloseTo(12.96);
  });

  it("reads a type step written as its scale's base times a ratio", () => {
    const scale = tokenSizes(
      "--ox-a-base: 0.875rem;\n--ox-a-body: var(--ox-a-base);\n--ox-a-micro: calc(var(--ox-a-base) * 0.857143);",
    );
    expect(scale.get("--ox-a-body")).toBe(14);
    expect(scale.get("--ox-a-micro")).toBeCloseTo(12, 4);
  });

  it("reads no step without the base it multiplies, and no alias of an unknown token", () => {
    expect(tokenSizes("--ox-radius-lg: calc(var(--ox-radius-base) * 1);").size).toBe(0);
    expect(tokenSizes("--ox-radius-card: var(--ox-radius-2xl);").size).toBe(0);
  });

  it("names the nearest step of the surface's own scale", () => {
    expect(suggestion("font-size", "15px", "m", sizes)).toBe("var(--ox-m-micro) (14px)");
    expect(suggestion("font-size", "13.5px", "a", sizes)).toBe("var(--ox-a-body) (14px)");
    expect(suggestion("font-size", "clamp(29px, 4.2vw, 44px)", "m", sizes)).toBe(
      "var(--ox-m-h3) (28px)",
    );
  });

  it("names the website card corner on a marketing page and the kit card in the app", () => {
    expect(suggestion("border-radius", "12px", "m", sizes)).toBe("var(--ox-radius) (12px)");
    expect(suggestion("border-radius", "12px", "a", sizes)).toBe(
      "var(--ox-radius-card) (12.96px)",
    );
    expect(suggestion("border-radius", "8px", "m", sizes)).toBe("var(--ox-radius-lg) (7.2px)");
  });

  it("falls back to the family name when the kit's sizes are unknown", () => {
    const none = new Map<string, number>();
    expect(suggestion("border-radius", "8px", "a", none)).toBe("a --ox-radius-* step");
    expect(suggestion("font-size", "15px", "m", none)).toBe("an --ox-m-* step");
  });

  it("falls back to the family name when the literal has no size to compare", () => {
    expect(suggestion("font-size", "0px", "m", sizes)).toBe("an --ox-m-* step");
  });

  it("names the shadow by where it sits, and the wrap by its token", () => {
    const shadow = suggestion("box-shadow", "0 1px 2px red", "m", sizes);
    expect(shadow).toContain("var(--ox-shadow-pop)");
    expect(shadow).toContain("var(--ox-shadow-ui)");
    expect(shadow).toContain("no shadow on a card at rest");
    expect(suggestion("width", "1500px", "a", sizes)).toContain("var(--ox-wrap)");
  });
});

describe("the guard", () => {
  const guarded = [
    { path: "site.css", scale: "m" as const },
    { path: "app.css", scale: "a" as const },
  ];

  it("lists each literal with its file, line, and the token to use", () => {
    const files = new Map([
      ["site.css", ":root {\n  --r: 8px;\n}\n.card {\n  font-size: 15px !important;\n}\n"],
      ["app.css", ".x { border-radius: var(--ox-radius-lg); }\n"],
    ]);
    const { hits, stale } = literalDrift(files, { tokens: TOKENS, guarded, keep: {} });
    expect(hits).toEqual([
      { path: "site.css", line: 2, prop: "--r", value: "8px", use: "var(--ox-radius-lg) (7.2px)" },
      {
        path: "site.css",
        line: 5,
        prop: "font-size",
        value: "15px",
        use: "var(--ox-m-micro) (14px)",
      },
    ]);
    expect(stale).toEqual([]);
  });

  it("passes a literal its file keeps, and lists a kept literal the file no longer writes", () => {
    const files = new Map([["app.css", "th { font-size: 10.5px; }\n"]]);
    const keep = {
      "app.css": [{ prop: "font-size", values: ["10.5px", "13px"], why: "the mockup's table" }],
    };
    expect(literalDrift(files, { tokens: TOKENS, guarded, keep })).toEqual({
      hits: [],
      stale: [{ path: "app.css", prop: "font-size", value: "13px" }],
    });
  });

  it("keeps a value only in its own group", () => {
    const files = new Map([["app.css", ".x { border-radius: 13px; }\n"]]);
    const keep = { "app.css": [{ prop: "font-size", values: ["13px"], why: "x" }] };
    const { hits, stale } = literalDrift(files, { tokens: TOKENS, guarded, keep });
    expect(hits.map((h) => h.value)).toEqual(["13px"]);
    expect(stale).toEqual([{ path: "app.css", prop: "font-size", value: "13px" }]);
  });

  it("skips a file it was not given, and needs no kit to run", () => {
    const files = new Map<string, string | null>([["site.css", null]]);
    expect(literalDrift(files, { guarded, keep: {} })).toEqual({ hits: [], stale: [] });
    const bare = new Map([["app.css", ".x { font-size: 13px; }"]]);
    expect(literalDrift(bare, { guarded, keep: {} }).hits[0]?.use).toBe("an --ox-a-* step");
  });

  it("guards each surface's stylesheets on its own scale", () => {
    const scales = Object.fromEntries(GUARDED.map((g) => [g.path, g.scale]));
    expect(scales["apps/web/assets/oxagen.css"]).toBe("m");
    expect(scales["apps/web/assets/blog.css"]).toBe("m");
    expect(scales["apps/web/assets/legal.css"]).toBe("m");
    expect(scales["packages/ui/src/styles/globals.css"]).toBe("a");
    expect(scales["apps/app/src/app/globals.css"]).toBe("a");
  });

  it("gives every kept literal a reason, and keeps only guarded files", () => {
    const paths = new Set(GUARDED.map((g) => g.path));
    for (const [path, entries] of Object.entries(KEEP)) {
      expect(paths.has(path), path).toBe(true);
      for (const entry of entries) {
        expect(["border-radius", "box-shadow", "font-size", "width"]).toContain(entry.prop);
        expect(entry.why.length, `${path} ${entry.prop}`).toBeGreaterThan(10);
        expect(entry.values.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("the docs markup", () => {
  const guarded = [{ path: "page.tsx", scale: "a" as const }];
  const drift = (src: string) =>
    markupDrift(new Map([["page.tsx", src]]), { tokens: TOKENS, guarded });

  it("lists a fixed Tailwind size with the nearest class on the file's scale", () => {
    const src = [
      'export const a = "flex text-sm font-medium";',
      'export const b = "md:text-xl text-xs";',
    ].join("\n");
    expect(drift(src)).toEqual([
      { path: "page.tsx", line: 1, prop: "class", value: "text-sm", use: "text-a-body (14px)" },
      { path: "page.tsx", line: 2, prop: "class", value: "text-xl", use: "text-a-h3 (20px)" },
      { path: "page.tsx", line: 2, prop: "class", value: "text-xs", use: "text-a-micro (12px)" },
    ]);
  });

  it("lists a class on the other scale", () => {
    expect(drift('const a = "text-m-body";').map((h) => h.use)).toEqual([
      "text-a-body, on this surface's own scale",
    ]);
  });

  it("passes the kit's classes, a token, and a colour", () => {
    expect(
      drift('const a = "text-a-body text-fd-muted-foreground text-[var(--ox-a-body)] text-[color:var(--x)]";'),
    ).toEqual([]);
  });

  it("lists a length in square brackets and passes what a stylesheet may keep", () => {
    const src =
      `const a = "text-[13.5px] rounded-[8px] rounded-tl-[0.5rem] shadow-[0_1px_2px_red] text-[0.9em] rounded-[999px] shadow-[0_0_0_1px_red]";`;
    expect(drift(src).map((h) => [h.value, h.use])).toEqual([
      ["text-[13.5px]", "var(--ox-a-body) (14px)"],
      ["rounded-[8px]", "var(--ox-radius-lg) (7.2px)"],
      ["rounded-tl-[0.5rem]", "var(--ox-radius-lg) (7.2px)"],
      ["shadow-[0_1px_2px_red]", expect.stringContaining("var(--ox-shadow-pop)")],
    ]);
  });

  it("reads no class out of a comment, and keeps the line count", () => {
    const src = '// text-sm\n/* text-lg\n rounded-[8px] */\nconst url = "https://x.dev"; const a = "text-xs";';
    expect(stripMarkupComments(src).split("\n")).toHaveLength(4);
    expect(drift(src)).toEqual([
      { path: "page.tsx", line: 4, prop: "class", value: "text-xs", use: "text-a-micro (12px)" },
    ]);
  });

  it("skips a file it was not given, and needs no kit to run", () => {
    expect(markupDrift(new Map<string, string | null>([["page.tsx", null]]), { guarded })).toEqual(
      [],
    );
    const hits = markupDrift(new Map([["page.tsx", 'const a = "text-sm";']]), { guarded });
    expect(hits[0]?.use).toBe("a text-a-* class");
  });

  it("guards the docs chrome on the app scale", () => {
    expect(GUARDED_MARKUP.length).toBeGreaterThan(0);
    for (const { path, scale } of GUARDED_MARKUP) {
      expect(path.startsWith("apps/docs/"), path).toBe(true);
      expect(scale).toBe("a");
    }
  });

  // oxageninc/brand#83: the landing pages keep Tailwind's steps, which the
  // kit maps to its own, and are held to the bracket rule only.
  it("holds a brackets entry to the bracket rule only", () => {
    const hits = markupDrift(
      new Map([
        [
          "landing.tsx",
          'const a = "text-sm text-4xl text-[11px] text-[0.8em] text-[0.9em] text-[length:var(--ox-a-micro)]";',
        ],
      ]),
      { tokens: TYPE_TOKENS, guarded: [{ path: "landing.tsx", scale: "a", brackets: true }] },
    );
    expect(hits.map((h) => [h.value, h.use])).toEqual([["text-[11px]", "var(--ox-a-body) (14px)"]]);
  });
});

/** The kit's sizes after oxageninc/brand#83: no step under 14px. */
const TYPE_TOKENS = `
:root {
  --ox-m-h1: 4.5rem;
  --ox-m-h2: 2.5rem;
  --ox-m-h3: 1.75rem;
  --ox-m-h4: 1.25rem;
  --ox-m-body: 1rem;
  --ox-m-micro: 0.875rem;
  --ox-a-h1: 1.875rem;
  --ox-a-h2: 1.5rem;
  --ox-a-h3: 1.25rem;
  --ox-a-h4: 1rem;
  --ox-a-body: 0.875rem;
  --ox-a-micro: 0.875rem;
}
`;

describe("the type rule: reading a page", () => {
  it("keeps only a page's <style> blocks, with the page's own line numbers", () => {
    const html = "<p>a</p>\n<style>\n.a { font-size: 12px; }\n</style>\n<p>b</p>\n";
    const { css } = pageCss(html);
    expect(css.split("\n")).toHaveLength(html.split("\n").length);
    expect(css).not.toContain("<p>");
    expect(declarations(css)).toEqual([{ prop: "font-size", value: "12px", line: 3 }]);
  });

  it("reads style attributes, SVG text sizes, and sizes a script sets", () => {
    const html = [
      '<p style="font-size:13px;color:red">b</p>',
      '<svg><text font-size="11">c</text></svg>',
      "<script>el('text', { x: 1, 'font-size': 9 })</script>",
    ].join("\n");
    expect(pageCss(html).inline).toEqual([
      { prop: "font-size", value: "13px", line: 1 },
      { prop: "color", value: "red", line: 1 },
      { prop: "font-size", value: "11px", line: 2 },
      { prop: "font-size", value: "9px", line: 3 },
    ]);
  });

  it("lists each innermost rule with its selector, and no at-rule", () => {
    const css = '@font-face { font-family: "A"; }\n.a,\n.b {\n  color: red;\n}\n@media (max-width: 9px) { h1 { font-size: 1px; } }\n';
    expect(rules(css)).toEqual([
      { selector: ".a, .b", body: "\n  color: red;\n", line: 2, bodyLine: 3 },
      { selector: "h1", body: " font-size: 1px; ", line: 6, bodyLine: 6 },
    ]);
  });

  it("finds the h1 to h3 a selector styles, and no pseudo-element or descendant", () => {
    expect([...headingsOf(".hero h1, h2.title, h1 span, h2::before, h3:hover, .x > h4")]).toEqual([
      "h1",
      "h2",
      "h3",
    ]);
  });

  it.each([
    ["400 var(--ox-m-body) / var(--ox-m-body-leading) var(--font-sans)", "var(--ox-m-body)", "var(--font-sans)"],
    ["500 10px ui-monospace, monospace", "10px", "ui-monospace, monospace"],
    ["400 var(--fs-small)/1.6 var(--ox-font)", "var(--fs-small)", "var(--ox-font)"],
    ["inherit", null, null],
    ["var(--ox-font)", null, null],
  ])("reads the size and faces of the shorthand font: %s", (value, size, family) => {
    expect(shorthandSize(value)).toBe(size);
    expect(shorthandFamily(value)).toBe(family);
  });
});

describe("the type rule: the heading face", () => {
  it.each([
    ["var(--ox-font-display)", true],
    ["var(--font-display)", true],
    ['"Space Grotesk", sans-serif', true],
    ["var(--ox-font)", false],
    ["var(--font-sans)", false],
  ])("reads %s as Space Grotesk: %s", (value, display) => {
    expect(isDisplayFace(value, new Map())).toBe(display);
  });

  it("follows a site's own property, and fails one it points at another face", () => {
    const routed = customProperties([":root { --font-heading: var(--ox-font-display); }"]);
    expect(isDisplayFace("var(--font-heading)", routed)).toBe(true);
    const repointed = customProperties([":root { --font-display: var(--ox-font); }"]);
    expect(isDisplayFace("var(--font-display)", repointed)).toBe(false);
  });
});

describe("the type rule on the customer sites", () => {
  const guarded = [
    { path: "site.css", scale: "m" as const, site: "web" as const, faces: true },
    { path: "app.css", scale: "a" as const },
  ];
  const pages = [
    { path: "page.html", scale: "m" as const, site: "web" as const, with: ["site.css"] },
  ];
  it("lists a face named by hand, a size by hand in a page, and a heading in the wrong face", () => {
    const files = new Map([
      [
        "site.css",
        [
          ":root { --fs-micro: var(--ox-m-micro); --fs-tiny: calc(var(--ox-m-micro) * 0.8); }",
          "h1, h2, h3 { font-family: var(--ox-font-display); }",
          ".tag { font-size: var(--fs-tiny); }",
          ".code { font-family: ui-monospace, monospace; }",
          '@font-face { font-family: "Aeonik"; src: url(x); }',
        ].join("\n"),
      ],
      ["app.css", ".x { font-size: 10px; font-family: Arial; }\n"],
      [
        "page.html",
        [
          "<style>",
          ".a { font-size: var(--fs-micro); }",
          ".b { font-size: 15px; }",
          ".c h2 { font-family: var(--ox-font); }",
          "</style>",
          '<p style="font-size:12px">x</p>',
          "<script>el('text', { 'font-size': 11 })</script>",
        ].join("\n"),
      ],
    ]);
    expect(typeDrift(files, { tokens: TYPE_TOKENS, guarded, pages })).toEqual([
      {
        path: "site.css",
        line: 4,
        prop: "font-family",
        value: "ui-monospace, monospace",
        use: expect.stringContaining("var(--ox-font-mono) for code"),
      },
      { path: "page.html", line: 3, prop: "font-size", value: "15px", use: "var(--ox-m-body) (16px)" },
      { path: "page.html", line: 6, prop: "font-size", value: "12px", use: "var(--ox-m-micro) (14px)" },
      { path: "page.html", line: 7, prop: "font-size", value: "11px", use: "var(--ox-m-micro) (14px)" },
      {
        path: "page.html",
        line: 4,
        prop: "font-family",
        value: "var(--ox-font)",
        use: expect.stringContaining("Space Grotesk on h2"),
      },
    ]);
  });

  it("requires a faces file to set h1 to h3 in Space Grotesk, the kit's way or its own", () => {
    const only = [{ path: "root.css", scale: "a" as const, site: "docs" as const, faces: true }];
    const run = (css: string) =>
      typeDrift(new Map([["root.css", css]]), { tokens: TYPE_TOKENS, guarded: only, pages: [] });
    expect(run(":root { --x: 1px; }")).toEqual([
      {
        path: "root.css",
        line: 1,
        prop: "font-family",
        value: "(none)",
        use: expect.stringContaining("sets h1, h2, h3 in Space Grotesk"),
      },
    ]);
    expect(run(":root { --font-heading: var(--font-display); }")).toEqual([]);
    expect(run("h1,\nh2,\nh3 { font-family: var(--ox-font-display); }")).toEqual([]);
    expect(
      run(":root { --font-display: var(--ox-font); }\nh1, h2, h3 { font-family: var(--font-display); }").map(
        (h) => `${h.line} ${h.value}`,
      ),
    ).toEqual(["2 var(--font-display)", "1 (none)"]);
  });

  it("skips a file it was not given, and a stylesheet of no site", () => {
    expect(
      typeDrift(new Map<string, string | null>([["site.css", null]]), {
        tokens: TYPE_TOKENS,
        guarded,
        pages: [],
      }),
    ).toEqual([]);
  });

  it("guards the two customer sites, every page with the stylesheets it links", () => {
    const sheets = new Set(GUARDED.map((g) => g.path));
    for (const g of GUARDED.filter((x) => x.site)) {
      expect(/^apps\/(web|docs)\//.test(g.path), g.path).toBe(true);
      for (const w of g.with ?? []) expect(sheets.has(w), w).toBe(true);
    }
    expect(GUARDED.filter((g) => g.faces).map((g) => g.path)).toEqual([
      "apps/docs/src/app/global.css",
      "apps/web/assets/oxagen.css",
    ]);
    for (const p of GUARDED_PAGES) {
      expect(p.path.startsWith("apps/web/"), p.path).toBe(true);
      // A page either links the site stylesheet or sets its own heading face.
      expect(Boolean(p.faces) !== Boolean(p.with?.length), p.path).toBe(true);
      for (const w of p.with ?? []) expect(sheets.has(w), w).toBe(true);
    }
  });

  it("keeps no font size by hand on a customer site", () => {
    for (const g of GUARDED.filter((x) => x.site)) {
      const sizes = (KEEP[g.path] ?? []).filter((entry) => entry.prop === "font-size");
      expect(sizes, g.path).toEqual([]);
    }
  });
});
