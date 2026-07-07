// @vitest-environment jsdom
/**
 * risk-badge.test.tsx
 *
 * Render tests for RiskBadge (the calm, non-alarming risk indicator):
 *   - Low risk renders nothing at all
 *   - Medium/high render a small neutral outline badge with a shield icon
 *   - No inline color styles (no red/amber fill)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RiskBadge } from "./risk-badge";

afterEach(cleanup);

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant,
    size,
    className,
    ...rest
  }: {
    children: React.ReactNode;
    variant?: string;
    size?: string;
    className?: string;
  }) => (
    <span data-variant={variant} data-size={size} className={className} {...rest}>
      {children}
    </span>
  ),
}));

vi.mock("lucide-react", () => ({
  ShieldAlert: () => <span data-testid="shield-icon" />,
}));

describe("RiskBadge", () => {
  it("renders nothing for low risk", () => {
    const { container } = render(<RiskBadge risk="low" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders 'Medium risk' in a neutral outline badge for medium risk", () => {
    render(<RiskBadge risk="medium" />);
    const badge = screen.getByTestId("risk-badge");
    expect(badge).toHaveTextContent("Medium risk");
    expect(badge).toHaveAttribute("data-variant", "outline");
    expect(badge).toHaveAttribute("data-size", "sm");
    expect(badge).toHaveAttribute("data-risk", "medium");
  });

  it("renders 'High risk' in a neutral outline badge for high risk", () => {
    render(<RiskBadge risk="high" />);
    const badge = screen.getByTestId("risk-badge");
    expect(badge).toHaveTextContent("High risk");
    expect(badge).toHaveAttribute("data-variant", "outline");
    expect(badge).toHaveAttribute("data-risk", "high");
  });

  it("includes the shield icon for elevated risk", () => {
    render(<RiskBadge risk="high" />);
    expect(screen.getByTestId("shield-icon")).toBeInTheDocument();
  });

  it("applies no inline color styles (no red/amber fill)", () => {
    render(<RiskBadge risk="high" />);
    const badge = screen.getByTestId("risk-badge");
    expect(badge.getAttribute("style")).toBeNull();
    expect(badge.className).toContain("text-muted-foreground");
  });
});
