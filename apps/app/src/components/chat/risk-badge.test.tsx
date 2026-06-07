// @vitest-environment jsdom
/**
 * risk-badge.test.tsx
 *
 * Render tests for RiskBadge:
 *   - Each risk level renders expected text and badge variant
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RiskBadge } from "./risk-badge";

afterEach(cleanup);

// Badge from @oxagen/ui just renders its children; stub it simply.
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-variant={variant}>{children}</span>
  ),
}));

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

  it("uses 'muted' variant for low risk", () => {
    const { container } = render(<RiskBadge risk="low" />);
    expect(container.querySelector("[data-variant='muted']")).not.toBeNull();
  });

  it("uses 'warning' variant for medium risk", () => {
    const { container } = render(<RiskBadge risk="medium" />);
    expect(container.querySelector("[data-variant='warning']")).not.toBeNull();
  });

  it("uses 'destructive' variant for high risk", () => {
    const { container } = render(<RiskBadge risk="high" />);
    expect(container.querySelector("[data-variant='destructive']")).not.toBeNull();
  });
});
