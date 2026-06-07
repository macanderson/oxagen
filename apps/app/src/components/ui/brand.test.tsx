// @vitest-environment jsdom
/**
 * brand.test.tsx — render tests for brand mark components.
 *
 * Note: SVG elements in JSDOM have className as SVGAnimatedString, not a plain
 * string. Use getAttribute("class") to test class membership on SVG elements.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { OxagenLogomark, OxagenWordmark, BrandMark, OxagenLockup } from "./brand";

afterEach(cleanup);

describe("OxagenLogomark — render", () => {
  it("renders an SVG with role=img", () => {
    const { getByRole } = render(<OxagenLogomark />);
    expect(getByRole("img", { name: "Oxagen logomark" })).toBeInTheDocument();
  });

  it("accepts className via getAttribute", () => {
    const { getByRole } = render(<OxagenLogomark className="size-7" />);
    // SVG className is SVGAnimatedString in JSDOM — use getAttribute("class")
    expect(getByRole("img").getAttribute("class")).toContain("size-7");
  });
});

describe("OxagenWordmark — render", () => {
  it("renders an SVG with role=img", () => {
    const { getByRole } = render(<OxagenWordmark />);
    expect(getByRole("img", { name: "Oxagen" })).toBeInTheDocument();
  });

  it("accepts className via getAttribute", () => {
    const { getByRole } = render(<OxagenWordmark className="h-4" />);
    expect(getByRole("img", { name: "Oxagen" }).getAttribute("class")).toContain("h-4");
  });
});

describe("BrandMark — render", () => {
  it("renders without crashing", () => {
    const { container } = render(<BrandMark />);
    expect(container.firstChild).toBeTruthy();
  });

  it("contains an SVG logomark inside the tile", () => {
    const { container } = render(<BrandMark />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("tile has aria-hidden (decorative)", () => {
    const { container } = render(<BrandMark />);
    const tile = container.firstChild as HTMLElement;
    expect(tile.getAttribute("aria-hidden")).toBe("true");
  });

  it("merges custom className on tile", () => {
    const { container } = render(<BrandMark className="custom-brand" />);
    expect((container.firstChild as HTMLElement).className).toContain("custom-brand");
  });
});

describe("OxagenLockup — render", () => {
  it("renders without crashing and includes logomark SVG", () => {
    const { container } = render(<OxagenLockup />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("merges custom className on lockup span", () => {
    const { container } = render(<OxagenLockup className="custom-lockup" />);
    expect((container.firstChild as HTMLElement).className).toContain("custom-lockup");
  });
});
