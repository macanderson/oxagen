/**
 * The type audit (ADR-298): every size resolves from the kit's tokens, every
 * site gets the role its element implies, and a site under its role's floor
 * is flagged. The fixture tree is written to a temp dir, so the test reads
 * nothing outside the package.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  audit,
  flagsFor,
  lineBoxes,
  readPin,
  readScale,
  readTailwindMap,
  report,
  roleOf,
  roleOfSelector,
  selectorBefore,
  sitesIn,
  tagBefore,
} from "./type-audit.mjs";

const TOKENS = `
:root {
  --ox-a-base: 0.875rem;
  --ox-a-h2: calc(var(--ox-a-base) * 1.714286);
  --ox-a-body: var(--ox-a-base);
  --ox-a-micro: calc(var(--ox-a-base) * 0.857143);
  --ox-a-2xs: calc(var(--ox-a-base) * 0.714286);
  --ox-a-h2-leading: 1.2;
  --ox-a-body-leading: 1.5;
  --ox-a-micro-leading: 1.4;
  --ox-a-2xs-leading: 1.4;
}
`;

const TEXT_SCALE = `
@theme {
  --text-xs: var(--ox-a-2xs);
  --text-sm: var(--ox-a-micro);
  --text-base: var(--ox-a-body);
  --text-2xl: var(--ox-a-h2);
}
`;

const scale = readScale(TOKENS);

describe("readScale", () => {
  it("resolves each app step from the base and its ratio, with its leading", () => {
    expect(scale.basePx).toBe(14);
    expect(scale.steps.body).toEqual({ px: 14, leading: 1.5 });
    expect(scale.steps.micro).toEqual({ px: 12, leading: 1.4 });
    expect(scale.steps["2xs"]).toEqual({ px: 10, leading: 1.4 });
    expect(scale.steps.h2).toEqual({ px: 24, leading: 1.2 });
  });

  it("refuses tokens with no base", () => {
    expect(() => readScale(":root { --ox-a-body: 14px }")).toThrow(/--ox-a-base/);
  });

  it("reports each step's line box against the 4px grid", () => {
    const boxes = lineBoxes(scale);
    expect(boxes.find((b) => b.step === "body")).toEqual({ step: "body", px: 14, leading: 1.5, box: 21, onGrid: false });
    expect(boxes.find((b) => b.step === "2xs")?.onGrid).toBe(false);
    expect(boxes[0].step).toBe("h2");
  });
});

describe("readTailwindMap", () => {
  it("follows the entry's imports in order and lets a later block win", () => {
    const files: Record<string, string> = {
      "/app/globals.css": '@import "@oxagen/ui/styles/house-text-scale.css";\n@import "./local.css";\n',
      "/ui/house-text-scale.css": TEXT_SCALE,
      "/app/local.css": "@theme { --text-xs: var(--ox-a-micro); }",
    };
    const map = readTailwindMap("/app/globals.css", {
      read: (f) => files[f],
      exists: (f) => f in files,
      uiStyles: "/ui",
    });
    expect(map).toEqual({ xs: "micro", sm: "micro", base: "body", "2xl": "h2" });
  });
});

describe("roles", () => {
  it("reads the tag a class string sits on, on the same line or above", () => {
    const lines = ['<p className="text-sm">', "  <span", '    className="text-xs"', "  >"];
    expect(tagBefore(lines, 0, lines[0].indexOf("text-sm"))).toBe("p");
    expect(tagBefore(lines, 2, 4)).toBe("span");
  });

  it("gives running text the body role, labels the micro role, and axes and badges the 2xs role", () => {
    expect(roleOf("p", "", "x.tsx")).toBe("body");
    expect(roleOf("td", "", "x.tsx")).toBe("body");
    expect(roleOf("dt", "", "x.tsx")).toBe("label");
    expect(roleOf("span", "text-xs uppercase", "x.tsx")).toBe("label");
    expect(roleOf("span", "font-mono text-sm", "x.tsx")).toBe("data");
    expect(roleOf("h1", "", "x.tsx")).toBe("heading");
    expect(roleOf("text", "", "run/waterfall.tsx")).toBe("axis");
    expect(roleOf("span", "", "components/badge.tsx")).toBe("badge");
    expect(roleOf("div", "", "x.tsx")).toBe("unknown");
  });

  it("reads a stylesheet selector's role", () => {
    expect(selectorBefore(["table thead th {", "  padding: 0;", "  font-size: var(--ox-a-2xs);"], 2)).toBe("table thead th");
    expect(roleOfSelector("[data-shell-page] table thead th")).toBe("label");
    expect(roleOfSelector("[data-shell-page] table")).toBe("body");
    expect(roleOfSelector(".tx-fold")).toBe("unknown");
    expect(roleOfSelector(null)).toBe("unknown");
  });

  it("flags a site under its role's floor and tight leading on body text", () => {
    const flag = (role: string, px: number, tight = false) => flagsFor({ role, px, tight }, scale);
    expect(flag("body", 12)).toEqual(["running-text-below-base"]);
    expect(flag("body", 14)).toEqual([]);
    expect(flag("body", 14, true)).toEqual(["tight-leading-on-body"]);
    expect(flag("label", 10)).toEqual(["below-micro"]);
    expect(flag("label", 12)).toEqual([]);
    expect(flag("axis", 10)).toEqual([]);
    expect(flag("badge", 10)).toEqual([]);
    expect(flag("unknown", 10)).toEqual(["below-micro"]);
  });
});

describe("sitesIn", () => {
  const map = { xs: "2xs", sm: "micro", base: "body", "2xl": "h2" };

  it("lists each Tailwind size in a module with its tag, size and flags", () => {
    const src = [
      '<h1 className="text-2xl font-bold">Title</h1>',
      '<p className="text-sm text-muted-foreground">Running text</p>',
      '<span className="text-xs uppercase">Label</span>',
      '<td className="text-base">Cell</td>',
      '<p className="text-base leading-none">Tight</p>',
    ].join("\n");
    const sites = sitesIn("features/x.tsx", src, { scale, map });
    expect(sites.map((s) => [s.line, s.tag, s.px, s.flags])).toEqual([
      [1, "h1", 24, []],
      [2, "p", 12, ["running-text-below-base"]],
      [3, "span", 10, ["below-micro"]],
      [4, "td", 14, []],
      [5, "p", 14, ["tight-leading-on-body"]],
    ]);
  });

  it("lists each token font size in a stylesheet with its selector", () => {
    const css = ["table {", "  font-size: var(--ox-a-micro);", "}", "thead th {", "  font-size: var(--ox-a-2xs);", "}"].join("\n");
    const sites = sitesIn("app/globals.css", css, { scale, map });
    expect(sites.map((s) => [s.tag, s.px, s.flags])).toEqual([
      ["table", 12, ["running-text-below-base"]],
      ["thead th", 10, ["below-micro"]],
    ]);
  });

  it("skips a Tailwind size the map does not name", () => {
    expect(sitesIn("x.tsx", '<p className="text-7xl">Big</p>', { scale, map })).toEqual([]);
  });
});

describe("audit", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("scans a tree, resolves the scale through the entry's imports, and reports it", () => {
    root = mkdtempSync(join(tmpdir(), "type-audit-"));
    mkdirSync(join(root, "ui/styles"), { recursive: true });
    mkdirSync(join(root, "app/src/app"), { recursive: true });
    mkdirSync(join(root, "app/src/ui/probes"), { recursive: true });
    writeFileSync(join(root, "ui/styles/house-tokens.css"), TOKENS);
    writeFileSync(join(root, "ui/styles/house-text-scale.css"), TEXT_SCALE);
    writeFileSync(join(root, "app/src/app/globals.css"), '@import "@oxagen/ui/styles/house-text-scale.css";\ntable {\n  font-size: var(--ox-a-micro);\n}\n');
    writeFileSync(join(root, "app/src/ui/header.tsx"), '<h1 className="text-2xl">T</h1>\n<p className="text-sm">d</p>\n');
    writeFileSync(join(root, "app/src/ui/header.test.tsx"), '<p className="text-xs">ignored</p>\n');
    writeFileSync(join(root, "app/src/ui/probes/x.tsx"), '<p className="text-xs">ignored</p>\n');
    const result = audit({
      root,
      scanDirs: ["app/src"],
      tokens: "ui/styles/house-tokens.css",
      entry: "app/src/app/globals.css",
      uiStyles: "ui/styles",
    });
    expect(result.map.sm).toBe("micro");
    expect(result.histogram).toEqual({ 24: 1, 12: 2 });
    expect(result.flagged.map((s) => `${s.file}:${s.line}`)).toEqual(["app/src/app/globals.css:3", "app/src/ui/header.tsx:2"]);
    expect(result.byFlag).toEqual({ "running-text-below-base": 2 });
    const text = report(result, { pin: "abc1234", sizes: [{ px: 13, count: 61, nearest: 12, error: -1 }] });
    expect(text).toContain("micro  12px    text-sm");
    expect(text).toContain("Sites under their role (2)");
    expect(text).toContain("13px     x61   -> 12px   -1px");
  });
});

describe("readPin", () => {
  it("reads the SHA from ADR-226's pin block", () => {
    const adr = "### The pin\n\nThe mockup is read at one commit:\n\n```\noxageninc/roadmap @ 4eedf94560e05ed6574f44ae56d803f77f9094ce, path mockups/\n```\n";
    expect(readPin(adr)).toBe("4eedf94560e05ed6574f44ae56d803f77f9094ce");
    expect(readPin("no pin here")).toBeNull();
  });
});
