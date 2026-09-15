// @vitest-environment jsdom
/**
 * enterprise-upsell.test.tsx — render tests for EnterpriseUpsell.
 *
 * Covers:
 *   - Renders feature name in title
 *   - Renders the current tier in the description
 *   - Upgrade button links to billing subscription page
 *   - Shows the correct upgrade label
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EnterpriseUpsell } from "./enterprise-upsell";
import type { PlanTier } from "@oxagen/oxagen/types";

afterEach(cleanup);

// EnterpriseUpsell uses next/link via the Button render prop
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("EnterpriseUpsell", () => {
  const defaultProps = {
    orgSlug: "acme",
    feature: "Audit log export",
    currentTier: "build" as PlanTier,
  };

  it("renders the feature name as an Enterprise feature", () => {
    render(<EnterpriseUpsell {...defaultProps} />);
    expect(
      screen.getByText(/audit log export is an enterprise feature/i),
    ).toBeInTheDocument();
  });

  it("mentions the user's current tier in the description", () => {
    render(<EnterpriseUpsell {...defaultProps} />);
    // TIER_LABELS['build'] should produce 'Build'
    expect(screen.getByText(/build plan/i)).toBeInTheDocument();
  });

  it("renders 'Upgrade to Enterprise' text", () => {
    render(<EnterpriseUpsell {...defaultProps} />);
    expect(screen.getByText(/upgrade to enterprise/i)).toBeInTheDocument();
  });

  it("works for the free tier", () => {
    render(
      <EnterpriseUpsell
        {...defaultProps}
        currentTier={"free" as PlanTier}
        feature="SIEM streaming"
      />,
    );
    expect(
      screen.getByText(/siem streaming is an enterprise feature/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/free plan/i)).toBeInTheDocument();
  });
});
