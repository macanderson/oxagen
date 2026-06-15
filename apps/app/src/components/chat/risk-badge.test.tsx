// @vitest-environment jsdom
/**
 * risk-badge.test.tsx
 *
 * Render tests for RiskBadge:
 *   - Each risk level renders expected text
 *   - Each risk level applies the correct jewel-tone color and background
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RiskBadge } from "./risk-badge";

afterEach(cleanup);

describe("RiskBadge", () => {
  it("renders 'low risk' text for low risk level", () => {
    render(<RiskBadge risk="low" />);
    expect(screen.getByText("low risk")).toBeInTheDocument();
  });

  it("renders 'medium risk' text for medium risk level", () => {
    render(<RiskBadge risk="medium" />);
    expect(screen.getByText("medium risk")).toBeInTheDocument();
  });

  it("renders 'high risk' text for high risk level", () => {
    render(<RiskBadge risk="high" />);
    expect(screen.getByText("high risk")).toBeInTheDocument();
  });

  it("applies green jewel-tone color for low risk", () => {
    render(<RiskBadge risk="low" />);
    const el = screen.getByText("low risk");
    expect(el).toHaveStyle({ color: "rgb(103, 209, 130)" });
  });

  it("applies amber jewel-tone color for medium risk", () => {
    render(<RiskBadge risk="medium" />);
    const el = screen.getByText("medium risk");
    expect(el).toHaveStyle({ color: "rgb(255, 190, 99)" });
  });

  it("applies salmon jewel-tone color for high risk", () => {
    render(<RiskBadge risk="high" />);
    const el = screen.getByText("high risk");
    expect(el).toHaveStyle({ color: "rgb(255, 138, 107)" });
  });
});
