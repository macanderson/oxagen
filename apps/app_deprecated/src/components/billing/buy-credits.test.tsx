// @vitest-environment jsdom
/**
 * buy-credits.test.tsx — render + interaction tests for BuyCredits.
 *
 * Covers:
 *   - Renders the amount input (default $20)
 *   - Renders "Buy credits" button
 *   - Amount below $5 shows validation error
 *   - Buy button disabled when amount is invalid
 *   - Renders card heading and description
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BuyCredits } from "./buy-credits";

afterEach(cleanup);

// Mock the server action
vi.mock("@/app/[orgSlug]/billing/actions", () => ({
  buyCreditsAction: vi
    .fn()
    .mockResolvedValue({ ok: false, error: "Stripe error" }),
  cancelSubscriptionAction: vi.fn(),
  reactivateSubscriptionAction: vi.fn(),
  setSeatsAction: vi.fn(),
  previewSeatsAction: vi.fn(),
}));

// Mock buy-credits-preview-action (dynamic import)
vi.mock("./buy-credits-preview-action", () => ({
  getDiscountPreview: vi.fn().mockResolvedValue({
    grantCents: 2000,
    priceCents: 2000,
    percent: 0,
    savedCents: 0,
  }),
}));

// Mock toast
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

describe("BuyCredits — rendering", () => {
  it("renders 'Buy usage credits' heading", () => {
    render(<BuyCredits orgSlug="acme" />);
    expect(screen.getByText(/buy usage credits/i)).toBeInTheDocument();
  });

  it("renders the amount input with default $20", () => {
    render(<BuyCredits orgSlug="acme" />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("20");
  });

  it("renders the 'Buy credits' button", () => {
    render(<BuyCredits orgSlug="acme" />);
    expect(
      screen.getByRole("button", { name: /buy credits/i }),
    ).toBeInTheDocument();
  });

  it("renders credit = penny description", () => {
    render(<BuyCredits orgSlug="acme" />);
    expect(screen.getByText(/1 credit = 1¢/i)).toBeInTheDocument();
  });
});

describe("BuyCredits — validation", () => {
  it("shows minimum purchase error for amount below $5", async () => {
    render(<BuyCredits orgSlug="acme" />);
    const input = screen.getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "3");
    expect(screen.getByText(/minimum purchase is \$5/i)).toBeInTheDocument();
  });

  it("Buy button is disabled when amount is invalid", async () => {
    render(<BuyCredits orgSlug="acme" />);
    const input = screen.getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "2");
    expect(screen.getByRole("button", { name: /buy credits/i })).toBeDisabled();
  });

  it("Buy button is enabled for valid amount ($20)", () => {
    render(<BuyCredits orgSlug="acme" />);
    expect(
      screen.getByRole("button", { name: /buy credits/i }),
    ).not.toBeDisabled();
  });
});
