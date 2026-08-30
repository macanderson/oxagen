// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Sparkline } from "./sparkline";

afterEach(cleanup);

describe("Sparkline", () => {
  it("renders nothing for an empty series", () => {
    const { container } = render(<Sparkline values={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders a single polyline point for a one-value series without dividing by zero", () => {
    const { container } = render(<Sparkline values={[42]} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelector("polyline")).not.toBeNull();
  });

  it("renders a flat line for a constant series without dividing by zero", () => {
    const { container } = render(<Sparkline values={[10, 10, 10]} />);
    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
    // All y-coordinates should be identical (flat line), no NaN/Infinity.
    const points = polyline?.getAttribute("points") ?? "";
    expect(points).not.toContain("NaN");
    expect(points).not.toContain("Infinity");
  });

  it("scales an increasing series across the full height", () => {
    const { container } = render(
      <Sparkline values={[0, 5, 10]} height={32} width={120} />,
    );
    const polyline = container.querySelector("polyline");
    const points = (polyline?.getAttribute("points") ?? "").split(" ");
    expect(points).toHaveLength(3);
    const [firstY] = points[0]!.split(",").map(Number);
    const [, lastYRaw] = points[2]!.split(",");
    void firstY;
    expect(Number(lastYRaw)).toBeCloseTo(0, 1); // highest value maps to y=0
  });

  it("uses the provided aria-label", () => {
    const { getByRole } = render(
      <Sparkline values={[1, 2, 3]} aria-label="Daily spend trend" />,
    );
    expect(getByRole("img", { name: "Daily spend trend" })).toBeInTheDocument();
  });
});
