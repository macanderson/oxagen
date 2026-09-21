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
import { assertSurfaceMark, brandPath } from "./sync-brand-assets.mjs";

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
