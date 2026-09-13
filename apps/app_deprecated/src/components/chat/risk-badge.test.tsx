// @vitest-environment jsdom
/**
 * risk-badge.test.tsx
 *
 * Render tests for RiskBadge (the calm, non-alarming risk indicator):
 *   - Low risk renders nothing at all
 *   - Medium/high render a plain muted inline label with a shield icon
 *     (no chip, no border, no inline color styles)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RiskBadge } from "./risk-badge";

afterEach(cleanup);

vi.mock("lucide-react", () => ({
  ShieldAlert: () => <span data-testid="shield-icon" />,
}));

describe("RiskBadge", () => {
  it("renders nothing for low risk", () => {
    const { container } = render(<RiskBadge risk="low" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders 'Medium risk' as a plain muted label for medium risk", () => {
    render(<RiskBadge risk="medium" />);
    const label = screen.getByTestId("risk-badge");
    expect(label).toHaveTextContent("Medium risk");
    expect(label.tagName).toBe("SPAN");
    expect(label).toHaveAttribute("data-risk", "medium");
  });

  it("renders 'High risk' as a plain muted label for high risk", () => {
    render(<RiskBadge risk="high" />);
    const label = screen.getByTestId("risk-badge");
    expect(label).toHaveTextContent("High risk");
    expect(label.tagName).toBe("SPAN");
    expect(label).toHaveAttribute("data-risk", "high");
  });

  it("includes the shield icon for elevated risk", () => {
    render(<RiskBadge risk="high" />);
    expect(screen.getByTestId("shield-icon")).toBeInTheDocument();
  });

  it("applies no inline color styles and no chip styling (muted text only)", () => {
    render(<RiskBadge risk="high" />);
    const label = screen.getByTestId("risk-badge");
    expect(label.getAttribute("style")).toBeNull();
    expect(label.className).toContain("text-muted-foreground");
    expect(label.className).not.toContain("border");
    expect(label.className).not.toContain("bg-");
  });
});
