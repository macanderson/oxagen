// @vitest-environment jsdom
/**
 * balance-pill.test.tsx — render tests for BalancePill.
 *
 * Covers:
 *   - Renders formatted balance as a link to the billing page
 *   - Normal state: neutral styling (no warning class)
 *   - Low state: warning styling applied
 *   - Aria-label reflects the balance and intent
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BalancePill } from "./balance-pill";

afterEach(cleanup);

// Mock next/link — render the href as an <a> for testability
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("BalancePill", () => {
  it("renders a link to the billing page for the given org", () => {
    render(<BalancePill orgSlug="acme" balanceCents={1500} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/acme/billing/subscription");
  });

  it("displays the balance formatted as USD", () => {
    render(<BalancePill orgSlug="acme" balanceCents={1000} />);
    // $10.00
    expect(screen.getByRole("link")).toHaveTextContent("$10.00");
  });

  it("has an aria-label mentioning the balance and billing", () => {
    render(<BalancePill orgSlug="acme" balanceCents={500} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("aria-label")).toContain("$5.00");
    expect(link.getAttribute("aria-label")).toContain("billing");
  });

  it("applies warning class when low=true", () => {
    render(<BalancePill orgSlug="acme" balanceCents={200} low />);
    const link = screen.getByRole("link");
    // Contains the warning token
    expect(link.className).toContain("warning");
  });

  it("does NOT apply warning class when low is absent", () => {
    render(<BalancePill orgSlug="acme" balanceCents={2000} />);
    const link = screen.getByRole("link");
    expect(link.className).not.toContain("warning");
  });

  it("displays zero balance correctly", () => {
    render(<BalancePill orgSlug="acme" balanceCents={0} />);
    expect(screen.getByRole("link")).toHaveTextContent("$0.00");
  });

  it("abbreviates a large balance in the visible label but keeps the exact figure in the aria-label", () => {
    // $12,345.00 balance → compact "$12.3K" visible, exact "$12,345.00" in a11y.
    render(<BalancePill orgSlug="acme" balanceCents={1_234_500} />);
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("$12.3K");
    expect(link.getAttribute("aria-label")).toContain("$12,345.00");
  });
});
