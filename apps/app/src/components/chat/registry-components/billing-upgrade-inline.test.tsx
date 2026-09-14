// @vitest-environment jsdom
/**
 * billing-upgrade-inline.test.tsx
 *
 * Render + interaction tests for BillingUpgradeInline:
 *   - Renders plan options
 *   - Selects plan on click
 *   - Shows error message when changePlanAction fails
 *   - Shows success state (redirecting) on success
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

// Must mock BEFORE importing the component
vi.mock("@/app/[orgSlug]/billing/actions", () => ({
  changePlanAction: vi.fn(),
  buyCreditsAction: vi.fn(),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    "aria-busy": ariaBusy,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: string;
    "aria-busy"?: boolean;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-busy={ariaBusy}
    >
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    CreditCard: vi.fn(() => <span />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
    ArrowUpRight: vi.fn(() => <span />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("BillingUpgradeInline", () => {
  it("renders plan options", async () => {
    const { changePlanAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(changePlanAction).mockResolvedValue({ ok: true, url: null });

    const { default: BillingUpgradeInline } = await import(
      "./billing-upgrade-inline"
    );
    render(<BillingUpgradeInline />);
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Scale")).toBeInTheDocument();
    expect(screen.getByText("Enterprise")).toBeInTheDocument();
  });

  it("renders the upgrade form with aria-label", async () => {
    const { changePlanAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(changePlanAction).mockResolvedValue({ ok: true, url: null });

    const { default: BillingUpgradeInline } = await import(
      "./billing-upgrade-inline"
    );
    render(<BillingUpgradeInline />);
    expect(
      screen.getByRole("form", { name: "Upgrade plan" }),
    ).toBeInTheDocument();
  });

  it("defaults to 'build' plan when no suggestedPlan", async () => {
    const { changePlanAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(changePlanAction).mockResolvedValue({ ok: true, url: null });

    const { default: BillingUpgradeInline } = await import(
      "./billing-upgrade-inline"
    );
    render(<BillingUpgradeInline />);
    // Build button should be aria-pressed=true — there are multiple /Build/ buttons so find by aria-pressed
    const allButtons = screen.getAllByRole("button");
    const buildBtn = allButtons.find(
      (b) =>
        b.getAttribute("aria-pressed") === "true" &&
        b.textContent?.includes("Build"),
    );
    expect(buildBtn).toBeTruthy();
  });

  it("uses suggestedPlan to pre-select a plan", async () => {
    const { changePlanAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(changePlanAction).mockResolvedValue({ ok: true, url: null });

    const { default: BillingUpgradeInline } = await import(
      "./billing-upgrade-inline"
    );
    render(<BillingUpgradeInline suggestedPlan="scale" />);
    // Scale plan button should be aria-pressed=true
    const allButtons = screen.getAllByRole("button");
    const scaleBtn = allButtons.find(
      (b) =>
        b.getAttribute("aria-pressed") === "true" &&
        b.textContent?.includes("Scale"),
    );
    expect(scaleBtn).toBeTruthy();
  });

  it("shows error message when changePlanAction fails", async () => {
    const { changePlanAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(changePlanAction).mockResolvedValue({
      ok: false,
      error: "Payment required",
    });

    const { default: BillingUpgradeInline } = await import(
      "./billing-upgrade-inline"
    );
    render(<BillingUpgradeInline orgSlug="my-org" />);
    const submitBtn = screen.getByRole("button", { name: /Upgrade to/ });
    await userEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Payment required");
    });
  });

  it("shows success/redirecting state on successful submit", async () => {
    const { changePlanAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(changePlanAction).mockResolvedValue({ ok: true, url: null });
    // Stub window.location.assign
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { assign },
      writable: true,
    });

    const { default: BillingUpgradeInline } = await import(
      "./billing-upgrade-inline"
    );
    render(<BillingUpgradeInline orgSlug="my-org" />);
    const submitBtn = screen.getByRole("button", { name: /Upgrade to/ });
    await userEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByText("Redirecting to checkout…")).toBeInTheDocument();
    });
  });
});
