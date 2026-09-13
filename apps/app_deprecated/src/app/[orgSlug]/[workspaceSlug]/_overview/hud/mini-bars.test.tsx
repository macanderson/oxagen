// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MiniBars } from "./mini-bars";

afterEach(cleanup);

describe("MiniBars", () => {
  it("renders nothing for an empty series", () => {
    const { container } = render(<MiniBars values={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders one <rect> per value for a normal series", () => {
    const { container } = render(<MiniBars values={[1, 5, 3, 8, 2]} />);
    const svg = container.querySelector('[data-testid="overview-mini-bars"]');
    expect(svg).not.toBeNull();
    const rects = container.querySelectorAll("rect");
    expect(rects).toHaveLength(5);
  });

  it("renders bars for an all-zero series without dividing by zero", () => {
    const { container } = render(<MiniBars values={[0, 0, 0, 0]} />);
    const rects = container.querySelectorAll("rect");
    expect(rects).toHaveLength(4);
    rects.forEach((rect) => {
      const height = rect.getAttribute("height") ?? "";
      expect(height).not.toContain("NaN");
      expect(height).not.toContain("Infinity");
      expect(Number(height)).toBeGreaterThan(0);
    });
  });

  it("marks the last bar with the highlight fill class when highlightLast is set", () => {
    const { container } = render(<MiniBars values={[1, 2, 3]} highlightLast />);
    const rects = container.querySelectorAll("rect");
    expect(rects).toHaveLength(3);
    const last = rects[rects.length - 1]!;
    expect(last.getAttribute("class")).toContain("fill-primary");
    expect(last.getAttribute("class")).not.toContain("fill-primary/35");

    // Earlier bars should not carry the highlighted (exact "fill-primary") class.
    const first = rects[0]!;
    expect(first.getAttribute("class")).toContain("fill-primary/35");
  });

  it("does not highlight the last bar when highlightLast is false", () => {
    const { container } = render(
      <MiniBars values={[1, 2, 3]} highlightLast={false} />,
    );
    const rects = container.querySelectorAll("rect");
    const last = rects[rects.length - 1]!;
    expect(last.getAttribute("class")).toContain("fill-primary/35");
  });
});
