import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assertSurfaceMark,
  brandPath,
  expectedInk,
  rewriteInk,
} from "./sync-brand-assets.mjs";

describe("brand kit selection", () => {
  it("finds the current sibling checkout without an override", () => {
    expect(brandPath([], {}, "/projects/oxagen")).toBe(
      "/projects/oxagen-brand",
    );
  });

  it("prefers the new variable while accepting the transition alias", () => {
    expect(brandPath([], { OXAGEN_HOUSE_BRAND: "/old-kit" })).toBe("/old-kit");
    expect(
      brandPath([], {
        OXAGEN_BRAND_KIT: "/kit",
        OXAGEN_HOUSE_BRAND: "/old-kit",
      }),
    ).toBe("/kit");
    expect(
      brandPath(["--brand", "/explicit-kit"], {
        OXAGEN_BRAND_KIT: "/kit",
      }),
    ).toBe("/explicit-kit");
  });
});

describe("surface mark selection", () => {
  it.each([
    "apps/app/public",
    "apps/docs/public",
    "apps/app_deprecated/public",
  ])("admits selected wordmarks, icons, and avatars in %s", (surface) => {
    for (const brand of ["oxagen", "stella"]) {
      for (const variant of ["wordmark", "icon", "avatar-dark"]) {
        expect(() =>
          assertSurfaceMark(`${surface}/brand/${brand}-${variant}.svg`),
        ).not.toThrow();
      }
    }
    expect(() =>
      assertSurfaceMark(`${surface}/brand/oxagen-lockup.svg`),
    ).toThrow("not selected");
  });

  it("applies the web surface's own selection", () => {
    expect(() =>
      assertSurfaceMark("apps/web/assets/brand/oxagen-spinner.svg"),
    ).not.toThrow();
    expect(() =>
      assertSurfaceMark("apps/web/assets/brand/stella-wordmark.svg"),
    ).toThrow("not selected");
    expect(() =>
      assertSurfaceMark("apps/web/assets/brand/oxagen-lockup-dark.svg"),
    ).toThrow("not selected");
  });

  it("refuses marks on an undeclared surface and leaves other assets alone", () => {
    expect(() =>
      assertSurfaceMark("apps/new/public/brand/oxagen-wordmark.svg"),
    ).toThrow("not selected");
    expect(() =>
      assertSurfaceMark("apps/app/public/favicon/favicon.svg"),
    ).not.toThrow();
  });
});

describe("surface checks without a kit", () => {
  it("ignores Finder metadata but still refuses an unselected mark", () => {
    const root = mkdtempSync(join(tmpdir(), "oxagen-brand-check-"));
    try {
      const script = join(root, "tools/scripts/sync-brand-assets.mjs");
      mkdirSync(dirname(script), { recursive: true });
      copyFileSync(
        fileURLToPath(new URL("./sync-brand-assets.mjs", import.meta.url)),
        script,
      );
      const surface = join(root, "apps/app/public/brand");
      mkdirSync(surface, { recursive: true });
      writeFileSync(join(surface, ".DS_Store"), "finder metadata");
      const run = () =>
        spawnSync(
          process.execPath,
          [script, "--check", "--brand", join(root, "missing-kit")],
          { encoding: "utf8" },
        );
      const valid = run();
      expect(valid.status).toBe(0);
      expect(valid.stdout).toContain("brand: SKIPPED");
      writeFileSync(join(surface, "oxagen-lockup.svg"), "<svg/>");
      const invalid = run();
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain("not selected");
      expect(invalid.stdout).not.toContain("brand: SKIPPED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #3074: the check verified nothing about apps/web's art modules, and
// theme.mjs had drifted (INK.dim #52525B against the kit's #71717A).
describe("the web art palette", () => {
  const kit = {
    ink: "#09090B",
    panel: "#18181B",
    hl: "#27272A",
    border: "#27272A",
    rule: "#3F3F46",
    dim: "#71717A",
    muted: "#A1A1AA",
    "text-body": "#E4E4E7",
    text: "#FFFFFF",
    gold: "#D4AF37",
  };
  const theme = [
    "// header",
    "export const INK = Object.freeze({",
    '  ground: "#09090B",',
    '  dim: "#52525B",',
    '  silver: "#A1A1AA",',
    "});",
    "",
    "export function lineTones(t = INK) {",
    "  return [t.dim];",
    "}",
    "",
  ].join("\n");
  const map = { ground: "ink", dim: "dim", silver: "muted" };

  it("maps each INK key to the hex of the kit token it names", () => {
    expect(expectedInk(kit, map)).toEqual({
      ground: "#09090B",
      dim: "#71717A",
      silver: "#A1A1AA",
    });
  });

  it("covers every INK key with a real kit token by default", () => {
    const ink = expectedInk(kit);
    expect(Object.keys(ink).sort()).toEqual(
      [
        "body",
        "dim",
        "gold",
        "ground",
        "line",
        "muted",
        "panel",
        "raised",
        "rule",
        "silver",
        "text",
      ].sort(),
    );
  });

  it("fails loudly on a token the kit does not define", () => {
    expect(() => expectedInk({}, { dim: "dim" })).toThrow(
      'house kit has no colour token "dim" for INK.dim',
    );
  });

  it("rewrites a drifted value and leaves everything else byte for byte", () => {
    const out = rewriteInk(theme, expectedInk(kit, map));
    expect(out).not.toBe(theme);
    expect(out).toBe(theme.replace('dim: "#52525B"', 'dim: "#71717A"'));
  });

  it("returns the source unchanged when it already matches, so --check passes", () => {
    const current = theme.replace('dim: "#52525B"', 'dim: "#71717A"');
    expect(rewriteInk(current, expectedInk(kit, map))).toBe(current);
  });

  it("refuses a palette it cannot read rather than passing over it", () => {
    expect(() => rewriteInk("export const X = 1;\n", { dim: "#71717A" })).toThrow(
      "no `export const INK` block",
    );
    expect(() => rewriteInk(theme, { gold: "#D4AF37" })).toThrow(
      "INK has no gold colour",
    );
  });
});
