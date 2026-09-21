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
