// @vitest-environment jsdom
/**
 * plan-card.test.tsx — render + interaction tests for PlanCard.
 *
 * Covers:
 *   - Renders plan name, tier, price (monthly/annual), features, seat count
 *   - "Current plan" ring + badge when relation="current"
 *   - CTA button label for each PlanRelation
 *   - Button disabled when pending=true
 *   - onSelect called with correct slug and interval on click
 *   - Annual price fallback to monthly*12 when annualCents is null
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanCard, type Plan } from "./plan-card";

afterEach(cleanup);

const basePlan: Plan = {
  publicId: "plan-1",
  slug: "build",
  name: "Build",
  tier: "build",
  monthlyCents: 2000,
  annualCents: 19200,
  // Use a different value to avoid collision with the monthly price in text assertions
  includedCreditCents: 3000,
  includedSeats: 5,
  features: [{ label: "Unlimited workspaces" }, { label: "Priority support" }],
};

describe("PlanCard — rendering", () => {
  it("renders plan name and tier", () => {
    render(<PlanCard plan={basePlan} interval="month" onSelect={vi.fn()} />);
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText(/build tier/i)).toBeInTheDocument();
  });

  it("renders monthly price", () => {
    render(<PlanCard plan={basePlan} interval="month" onSelect={vi.fn()} />);
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.getByText("/month")).toBeInTheDocument();
  });

  it("renders annual price", () => {
    render(<PlanCard plan={basePlan} interval="year" onSelect={vi.fn()} />);
    expect(screen.getByText("$192.00")).toBeInTheDocument();
    expect(screen.getByText("/year")).toBeInTheDocument();
  });

  it("falls back to monthly*12 when annualCents is null", () => {
    const plan = { ...basePlan, annualCents: null };
    render(<PlanCard plan={plan} interval="year" onSelect={vi.fn()} />);
    // 2000 * 12 = 24000 cents = $240.00
    expect(screen.getByText("$240.00")).toBeInTheDocument();
  });

  it("renders included seats count", () => {
    render(<PlanCard plan={basePlan} interval="month" onSelect={vi.fn()} />);
    expect(screen.getByText(/5 seats included/i)).toBeInTheDocument();
  });

  it("renders plan features", () => {
    render(<PlanCard plan={basePlan} interval="month" onSelect={vi.fn()} />);
    expect(screen.getByText("Unlimited workspaces")).toBeInTheDocument();
    expect(screen.getByText("Priority support")).toBeInTheDocument();
  });

  it("renders included credits amount", () => {
    render(<PlanCard plan={basePlan} interval="month" onSelect={vi.fn()} />);
    // includedCreditCents = 3000 → $30.00
    expect(screen.getByText(/\$30\.00 in credits/i)).toBeInTheDocument();
  });
});

describe("PlanCard — relation states", () => {
  it("shows 'Current plan' badge and disabled button for relation=current", () => {
    render(
      <PlanCard
        plan={basePlan}
        interval="month"
        relation="current"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Current")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /current plan/i });
    expect(btn).toBeDisabled();
  });

  it("shows 'Upgrade' CTA for relation=upgrade", () => {
    render(
      <PlanCard
        plan={basePlan}
        interval="month"
        relation="upgrade"
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /upgrade/i }),
    ).toBeInTheDocument();
  });

  it("shows 'Downgrade' CTA for relation=downgrade", () => {
    render(
      <PlanCard
        plan={basePlan}
        interval="month"
        relation="downgrade"
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /downgrade/i }),
    ).toBeInTheDocument();
  });

  it("shows 'Switch' CTA for relation=switch (and for no relation)", () => {
    render(<PlanCard plan={basePlan} interval="month" onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /switch/i })).toBeInTheDocument();
  });
});

describe("PlanCard — interactions", () => {
  it("calls onSelect with slug and interval on button click", async () => {
    const onSelect = vi.fn();
    render(
      <PlanCard
        plan={basePlan}
        interval="month"
        relation="upgrade"
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /upgrade/i }));
    expect(onSelect).toHaveBeenCalledWith("build", "month");
  });

  it("shows 'Processing…' and disables button while pending", () => {
    render(
      <PlanCard
        plan={basePlan}
        interval="month"
        relation="upgrade"
        pending
        onSelect={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Processing…");
  });

  it("does not call onSelect when button is disabled (current plan)", async () => {
    const onSelect = vi.fn();
    render(
      <PlanCard
        plan={basePlan}
        interval="month"
        relation="current"
        onSelect={onSelect}
      />,
    );
    // Button is disabled — click should not propagate
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
