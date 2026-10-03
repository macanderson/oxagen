// INV-37 (ARCHITECTURE.md §4): no module or stylesheet rule in the app writes
// a value by hand (Mac, 2026-10-03, #5283).
// hardcoded-values.ts holds the scan and says what counts. This file runs it
// over src/, compares it with apps/app/hardcoded-values-baseline.json, proves
// it on the probes, and proves the comparison fails both ways.
//
// The baseline only shrinks. A value the baseline does not allow fails, and so
// does a baseline entry the scan no longer finds as often. A change that
// replaces values with tokens runs `pnpm gen:hardcoded-values` in apps/app and
// commits the smaller baseline with it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Baseline,
  diffBaseline,
  type Finding,
  parseBaseline,
  RAW_BUTTON,
  scanFile,
  scannedFiles,
  scanTree,
  UI_SRC,
} from "./hardcoded-values";
import { APP_DIR, WHOLE_TREE_TIMEOUT_MS } from "./parse";

const PROBES = "src/test/arch/probes/hardcoded-values";

function baseline(): Baseline {
  return parseBaseline(
    readFileSync(path.join(APP_DIR, "hardcoded-values-baseline.json"), "utf8"),
  );
}

/** `<line> <token>` for every value the scan finds in a probe. */
function probe(name: string): string[] {
  const file = `${PROBES}/${name}`;
  return scanFile(file, readFileSync(path.join(APP_DIR, file), "utf8")).map(
    (finding) => `${String(finding.line)} ${finding.token}`,
  );
}

describe("hardcoded values: every value reaches the page through a token", () => {
  it("the baseline is an object of files, each token with a positive count or a reason", () => {
    expect(() => baseline()).not.toThrow();
  });

  it("reads packages/ui beside apps/app, and skips the kit's synced files", () => {
    const files = scannedFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        "src/app/globals.css",
        `${UI_SRC}styles/globals.css`,
        `${UI_SRC}components/dialog.tsx`,
      ]),
    );
    expect(files).not.toContain(`${UI_SRC}styles/house-tokens.css`);
    expect(files.some((file) => file.endsWith(".stories.tsx"))).toBe(false);
  });

  it(
    "every hard-coded value under src/ is in the baseline, and every baseline entry is still found",
    () => {
      expect(
        diffBaseline(scanTree(), baseline()),
        "Replace each added value with a token. After a change that removes values, run `pnpm gen:hardcoded-values` in apps/app and commit the baseline.",
      ).toEqual({ added: [], stale: [] });
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("the module scan reads the probe the way it reads a page", () => {
    expect(probe("raw.tsx")).toEqual([
      "5 p-[3px]",
      "9 gap-[10px]",
      "9 md:max-w-[720px]",
      "10 [overflow-wrap:anywhere]",
      "10 bg-foreground/[0.35]",
      "11 duration-200",
      "11 min-[67.5rem]:grid-cols-3",
      "11 rounded",
      "12 rounded-[${}px]",
      "13 style:width",
      "14 style:left",
      "14 style:padding",
      "15 style:height",
      `16 ${RAW_BUTTON}`,
      "17 colour:fill",
      "18 colour:stroke",
      "20 colour:color",
    ]);
    expect(probe("clean.tsx")).toEqual([]);
  });

  it("the stylesheet scan reads the probe the way it reads a page", () => {
    expect(probe("raw.css")).toEqual([
      "4 css:border-radius",
      "5 css:box-shadow",
      "6 css:padding",
      "7 css:max-width",
      "8 css:animation",
      "9 css:transition",
      "10 css:border-top-left-radius",
      "11 colour:color",
    ]);
    expect(probe("clean.css")).toEqual([]);
  });

  it("the comparison fails on a value the baseline does not allow and on an entry the scan no longer finds", () => {
    const found: Finding[] = [
      { file: "src/a.tsx", line: 3, token: "gap-[10px]" },
      { file: "src/a.tsx", line: 9, token: "gap-[10px]" },
      { file: "src/b.tsx", line: 4, token: RAW_BUTTON },
    ];
    const exact = {
      "src/a.tsx": { "gap-[10px]": 2 },
      "src/b.tsx": { [RAW_BUTTON]: 1 },
    };
    expect(diffBaseline(found, exact)).toEqual({ added: [], stale: [] });
    expect(
      diffBaseline(found, { "src/a.tsx": { "gap-[10px]": 2 } }),
    ).toEqual({ added: [`src/b.tsx:4 ${RAW_BUTTON}`], stale: [] });
    expect(
      diffBaseline(found, { ...exact, "src/a.tsx": { "gap-[10px]": 1 } }),
    ).toEqual({
      added: [
        "src/a.tsx:3 gap-[10px] (baseline 1, found 2)",
        "src/a.tsx:9 gap-[10px] (baseline 1, found 2)",
      ],
      stale: [],
    });
    expect(
      diffBaseline(found, {
        ...exact,
        "src/a.tsx": { "gap-[10px]": 3, "p-[3px]": 1 },
      }),
    ).toEqual({
      added: [],
      stale: [
        "src/a.tsx gap-[10px] (baseline 3, found 2)",
        "src/a.tsx p-[3px] (baseline 1, found 0)",
      ],
    });
  });

  it("a documented exception allows its token at any count and goes stale when the token is gone", () => {
    const found: Finding[] = [
      { file: "src/a.tsx", line: 3, token: "style:width" },
      { file: "src/a.tsx", line: 9, token: "style:width" },
    ];
    expect(
      diffBaseline(found, {
        "src/a.tsx": { "style:width": "Computed from the chart's data." },
        "src/c.tsx": { "style:height": "Computed from the chart's data." },
      }),
    ).toEqual({
      added: [],
      stale: ["src/c.tsx style:height (exception, found 0)"],
    });
  });

  it("the baseline parser refuses an array, a zero count, an empty reason, and a file with no token", () => {
    expect(() => parseBaseline('["src/a.tsx gap-[10px]"]')).toThrow(
      /object of files/,
    );
    expect(() => parseBaseline('{"src/a.tsx":{"gap-[10px]":0}}')).toThrow(
      /positive count/,
    );
    expect(() => parseBaseline('{"src/a.tsx":{"gap-[10px]":" "}}')).toThrow(
      /positive count/,
    );
    expect(() => parseBaseline('{"src/a.tsx":{}}')).toThrow(/holds no token/);
  });
});
