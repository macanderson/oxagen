import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  comparesRasterBytes,
  expectedInk,
  icoSizes,
  isCi,
  pngSize,
  rewriteInk,
} from "./sync-brand-assets.mjs";

const SCRIPT = fileURLToPath(new URL("./sync-brand-assets.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * `process.env` with `CI` set to `ci`. GitHub Actions sets `CI=true` for every
 * step, and the script fails a check without a kit there, so a spawn that
 * means to test the local skip has to clear it.
 */
function envWithCi(ci: string): NodeJS.ProcessEnv {
  return { ...process.env, CI: ci };
}

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
      copyFileSync(SCRIPT, script);
      // The script finds its entrypoint through the shared helper (#4664
      // item 1), so the fixture tree carries that module too.
      const helper = join(root, "tools/scripts/lib/is-entrypoint.mjs");
      mkdirSync(dirname(helper), { recursive: true });
      copyFileSync(
        fileURLToPath(new URL("./lib/is-entrypoint.mjs", import.meta.url)),
        helper,
      );
      // The script imports apps/web's INK map (#3074), so the fixture tree
      // carries that module where the repo does, or the child exits on
      // ERR_MODULE_NOT_FOUND before it checks anything.
      const theme = join(root, "apps/web/scripts/lib/theme.mjs");
      mkdirSync(dirname(theme), { recursive: true });
      copyFileSync(
        fileURLToPath(
          new URL("../../apps/web/scripts/lib/theme.mjs", import.meta.url),
        ),
        theme,
      );
      const surface = join(root, "apps/app/public/brand");
      mkdirSync(surface, { recursive: true });
      writeFileSync(join(surface, ".DS_Store"), "finder metadata");
      const run = () =>
        spawnSync(
          process.execPath,
          [script, "--check", "--brand", join(root, "missing-kit")],
          { encoding: "utf8", env: envWithCi("") },
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

// #3074: CI runs the check against the kit's main branch. A missing kit there
// means the checkout step broke, and the old skip-and-exit-0 would pass with
// nothing verified. Off CI, the loud skip stays.
describe("a check without a kit", () => {
  const run = (ci: string) =>
    spawnSync(process.execPath, [SCRIPT, "--check", "--brand", "/no/such/kit"], {
      encoding: "utf8",
      env: envWithCi(ci),
    });

  it("fails in CI and names the kit it could not find", () => {
    const result = run("true");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("brand: FAILED");
    expect(result.stderr).toContain("/no/such/kit");
    expect(result.stdout).not.toContain("brand: SKIPPED");
  });

  it("skips with a notice off CI", () => {
    const result = run("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("brand: SKIPPED");
    expect(result.stdout).toContain("no asset was verified");
  });
});

describe("CI and raster comparison", () => {
  it("reads CI from the variable GitHub Actions sets", () => {
    expect(isCi({ CI: "true" })).toBe(true);
    expect(isCi({ CI: "1" })).toBe(true);
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
  });

  it("compares raster bytes off CI and by size in CI", () => {
    expect(comparesRasterBytes(["--check"], {})).toBe(true);
    expect(comparesRasterBytes(["--check"], { CI: "true" })).toBe(false);
  });

  it("lets a flag override either default", () => {
    expect(comparesRasterBytes(["--check", "--rasters"], { CI: "true" })).toBe(
      true,
    );
    expect(comparesRasterBytes(["--check", "--no-rasters"], {})).toBe(false);
  });

  it("always renders rasters for a write", () => {
    expect(comparesRasterBytes([], { CI: "true" })).toBe(true);
    expect(comparesRasterBytes(["--no-rasters"], {})).toBe(true);
  });
});

// The CI image renders with librsvg 2.54 and the committed rasters came from
// 2.62, so a CI check reads each raster's size instead of its bytes. These
// readers are that check.
describe("raster size readers", () => {
  const committed = (path: string) => readFileSync(join(REPO_ROOT, path));

  it("reads a committed PNG's size", () => {
    expect(pngSize(committed("apps/app/public/favicon/favicon-32.png"))).toEqual(
      { width: 32, height: 32 },
    );
    expect(pngSize(committed("apps/app/public/pwa/icon-512.png"))).toEqual({
      width: 512,
      height: 512,
    });
  });

  it("reads the sizes a committed icon file lists", () => {
    expect(icoSizes(committed("apps/app/public/favicon/favicon.ico"))).toEqual([
      16, 32, 48,
    ]);
    expect(icoSizes(committed("apps/web/favicon.ico"))).toEqual([16, 32, 48]);
  });

  it("returns null for a file that is not a PNG or an icon", () => {
    const svgText = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(pngSize(null)).toBeNull();
    expect(pngSize(svgText)).toBeNull();
    expect(pngSize(Buffer.alloc(8))).toBeNull();
    expect(icoSizes(null)).toBeNull();
    expect(icoSizes(svgText)).toBeNull();
    expect(icoSizes(committed("apps/app/public/favicon/favicon-32.png"))).toBeNull();
  });

  it("reads a width byte of 0 as 256", () => {
    const icon = Buffer.alloc(6 + 16);
    icon.writeUInt16LE(1, 2);
    icon.writeUInt16LE(1, 4);
    icon.writeUInt8(0, 6);
    expect(icoSizes(icon)).toEqual([256]);
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
