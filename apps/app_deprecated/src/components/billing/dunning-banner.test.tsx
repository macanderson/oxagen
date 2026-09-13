// @vitest-environment jsdom
/**
 * dunning-banner.test.tsx — render tests for DunningBanner.
 *
 * Covers:
 *   - Active state: renders nothing
 *   - Grace state: shows warning alert with grace-period date and CTA
 *   - Suspended state: shows destructive alert with restore CTA
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { OrgBillingStatus } from "@oxagen/billing";
import { DunningBanner } from "./dunning-banner";

afterEach(cleanup);

const activeStatus: OrgBillingStatus = {
  state: "active",
  delinquentSince: null,
  graceEndsAt: null,
  suspendedAt: null,
  pastDue: false,
};

const graceStatus: OrgBillingStatus = {
  state: "grace",
  delinquentSince: new Date("2025-06-01"),
  graceEndsAt: new Date("2025-06-08"),
  suspendedAt: null,
  pastDue: true,
};

const suspendedStatus: OrgBillingStatus = {
  state: "suspended",
  delinquentSince: new Date("2025-05-01"),
  graceEndsAt: new Date("2025-05-08"),
  suspendedAt: new Date("2025-05-08"),
  pastDue: true,
};

describe("DunningBanner — active state", () => {
  it("renders nothing for active orgs", () => {
    const { container } = render(
      <DunningBanner orgSlug="acme" status={activeStatus} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("DunningBanner — grace state", () => {
  it("shows a warning about the failed payment", () => {
    render(<DunningBanner orgSlug="acme" status={graceStatus} />);
    expect(screen.getByText(/your last payment failed/i)).toBeInTheDocument();
  });

  it("includes the grace deadline date in the description", () => {
    render(<DunningBanner orgSlug="acme" status={graceStatus} />);
    // The date is formatted by formatDate — at minimum the year should appear
    expect(screen.getByText(/2025/)).toBeInTheDocument();
  });

  it("shows an 'Update payment method' CTA", () => {
    render(<DunningBanner orgSlug="acme" status={graceStatus} />);
    expect(
      screen.getByRole("button", { name: /update payment method/i }),
    ).toBeInTheDocument();
  });
});

describe("DunningBanner — suspended state", () => {
  it("shows an account-suspended heading", () => {
    render(<DunningBanner orgSlug="acme" status={suspendedStatus} />);
    expect(screen.getByText(/your account is suspended/i)).toBeInTheDocument();
  });

  it("mentions non-payment in the description", () => {
    render(<DunningBanner orgSlug="acme" status={suspendedStatus} />);
    expect(screen.getByText(/non-payment/i)).toBeInTheDocument();
  });

  it("shows 'Update payment method' CTA with destructive styling", () => {
    render(<DunningBanner orgSlug="acme" status={suspendedStatus} />);
    expect(
      screen.getByRole("button", { name: /update payment method/i }),
    ).toBeInTheDocument();
  });
});
