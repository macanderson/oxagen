// @vitest-environment jsdom
/**
 * risk-badge.test.tsx
 *
 * Render tests for RiskBadge:
 *   - Each risk level renders expected text
 *   - Each risk level applies the correct status token color (success/warning/error)
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

  it("applies the success token color for low risk", () => {
    render(<RiskBadge risk="low" />);
    const el = screen.getByText("low risk") as HTMLElement;
    expect(el.style.color).toBe("var(--success)");
  });

  it("applies the warning token color for medium risk", () => {
    render(<RiskBadge risk="medium" />);
    const el = screen.getByText("medium risk") as HTMLElement;
    expect(el.style.color).toBe("var(--warning)");
  });

  it("applies the error token color for high risk", () => {
    render(<RiskBadge risk="high" />);
    const el = screen.getByText("high risk") as HTMLElement;
    expect(el.style.color).toBe("var(--error)");
  });
});
