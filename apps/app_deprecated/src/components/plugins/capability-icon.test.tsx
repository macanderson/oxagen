// @vitest-environment jsdom
/**
 * capability-icon.test.tsx
 *
 * Covers:
 *   - resolveIconEntry(undefined) → { type: "default" }
 *   - resolveIconEntry([{ src: "https://..." }]) → { type: "image", src }
 *   - resolveIconEntry([{ src: "brain-circuit", color: "#f59e0b" }]) → { type: "lucide", iconName, color }
 *   - CapabilityIcon with an unknown iconName renders without throwing (fallback to Package)
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { resolveIconEntry, CapabilityIcon } from "./capability-icon";

afterEach(cleanup);

describe("resolveIconEntry", () => {
  it("returns { type: 'default' } when icons is undefined", () => {
    const result = resolveIconEntry(undefined);
    expect(result).toEqual({ type: "default" });
  });

  it("returns { type: 'default' } when icons is an empty array", () => {
    const result = resolveIconEntry([]);
    expect(result).toEqual({ type: "default" });
  });

  it("returns an image entry for an https:// src", () => {
    const result = resolveIconEntry([{ src: "https://example.com/x.png" }]);
    expect(result).toEqual({ type: "image", src: "https://example.com/x.png" });
  });

  it("returns an image entry for a data: URI", () => {
    const dataUri = "data:image/png;base64,abc123";
    const result = resolveIconEntry([{ src: dataUri }]);
    expect(result).toEqual({ type: "image", src: dataUri });
  });

  it("returns a lucide entry for a non-URL src", () => {
    const result = resolveIconEntry([
      { src: "brain-circuit", color: "#f59e0b" },
    ]);
    expect(result).toEqual({
      type: "lucide",
      iconName: "brain-circuit",
      color: "#f59e0b",
    });
  });

  it("returns a lucide entry without color when color is omitted", () => {
    const result = resolveIconEntry([{ src: "sparkles" }]);
    expect(result).toEqual({
      type: "lucide",
      iconName: "sparkles",
      color: undefined,
    });
  });
});

describe("CapabilityIcon", () => {
  it("renders an SVG element for a known iconName", () => {
    const { container } = render(
      <CapabilityIcon iconName="brain-circuit" color="#f59e0b" />,
    );
    // Lucide icons render as <svg> elements
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders without throwing for an unknown iconName (falls back to Package)", () => {
    // Should not throw; unknown names fall back to the Package icon.
    expect(() =>
      render(<CapabilityIcon iconName="this-icon-does-not-exist" />),
    ).not.toThrow();
  });

  it("still produces an SVG element when iconName is unrecognised", () => {
    const { container } = render(
      <CapabilityIcon iconName="totally-unknown-icon" />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("applies the container size via inline styles", () => {
    const { container } = render(
      <CapabilityIcon iconName="plug" color="#3b82f6" size={48} />,
    );
    const span = container.querySelector("span") as HTMLElement;
    expect(span.style.width).toBe("48px");
    expect(span.style.height).toBe("48px");
  });

  it("applies the color as the container background", () => {
    const { container } = render(
      <CapabilityIcon iconName="plug" color="#3b82f6" />,
    );
    const span = container.querySelector("span") as HTMLElement;
    // jsdom normalises hex → rgb; check the property is set.
    expect(span.style.backgroundColor).toBeTruthy();
  });
});
