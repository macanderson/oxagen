// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/components/ui/panel", () => ({
  Panel: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <div data-testid="panel-title">{title}</div>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-variant={variant}>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    render: renderProp,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    render?: React.ReactElement;
  }) => {
    if (renderProp) {
      // DialogTrigger / DialogClose pass render={<Button />} — we must render children through
      return <button onClick={onClick} disabled={disabled}>{children}</button>;
    }
    return <button onClick={onClick} disabled={disabled}>{children}</button>;
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ value, onChange, disabled, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input value={value} onChange={onChange} disabled={disabled} {...props} />
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open, onOpenChange }: { children: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => (
    <div data-open={open} data-testid="dialog">{children}</div>
  ),
  DialogTrigger: ({ children, render: renderProp }: { children: React.ReactNode; render?: React.ReactElement }) => (
    <div data-testid="dialog-trigger">{children}</div>
  ),
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogClose: ({ children, render: renderProp }: { children: React.ReactNode; render?: React.ReactElement }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  AlertTitle: ({ children }: { children: React.ReactNode }) => <strong>{children}</strong>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

vi.mock("@/lib/utils", () => ({
  formatDate: (d: string) => d,
  formatCents: (c: number) => `$${(c / 100).toFixed(2)}`,
}));

vi.mock("@/lib/billing-format", () => ({
  formatRelativeRenewal: vi.fn(() => "renews in 30 days"),
}));

vi.mock("@/app/[orgSlug]/billing/actions", () => ({
  cancelSubscriptionAction: vi.fn().mockResolvedValue({ ok: true }),
  reactivateSubscriptionAction: vi.fn().mockResolvedValue({ ok: true }),
  setSeatsAction: vi.fn().mockResolvedValue({ ok: true }),
  previewSeatsAction: vi.fn().mockResolvedValue({
    direction: "increase",
    requestedSeats: 5,
    currentSeats: 3,
    amountCents: 2000,
    isCharge: true,
    isCredit: false,
    blocked: null,
    card: null,
  }),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span />,
  CreditCard: () => <span data-testid="credit-card-icon" />,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const subscription = {
  publicId: "sub_123",
  status: "active",
  planSlug: "build",
  planName: "Build",
  billingInterval: "month" as const,
  currentPeriodStart: "2026-06-01",
  currentPeriodEnd: "2026-07-01",
  cancelAtPeriodEnd: false,
  seatCount: 3,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(cleanup);

// Import after mocks
const { SubscriptionSummary } = await import(
  "@/components/billing/subscription-summary"
);

describe("SubscriptionSummary", () => {
  describe("when subscription is null (Free plan)", () => {
    it("renders Free badge", () => {
      render(
        <SubscriptionSummary
          subscription={null}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      // "Free" appears in both the badge and the prose; target the badge by data-variant
      const freeBadge = screen.getAllByText("Free").find(
        (el) => el.getAttribute("data-variant") === "muted",
      );
      expect(freeBadge).toBeTruthy();
    });

    it("renders upgrade message", () => {
      render(
        <SubscriptionSummary
          subscription={null}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(
        screen.getByText(/Upgrade below for more credits/i),
      ).toBeTruthy();
    });
  });

  describe("when subscription is provided", () => {
    it("renders the plan name in the renewal statement", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.getByTestId("plan-name").textContent).toBe("Build");
    });

    it("renders the subscription status badge", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      const badge = screen.getByText("active");
      expect(badge).toBeTruthy();
      expect(badge.getAttribute("data-variant")).toBe("success");
    });

    it("shows 'Cancels at period end' badge when cancelAtPeriodEnd=true", () => {
      render(
        <SubscriptionSummary
          subscription={{ ...subscription, cancelAtPeriodEnd: true }}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.getByText("Cancels at period end")).toBeTruthy();
    });

    it("does NOT show 'Cancels at period end' badge when cancelAtPeriodEnd=false", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.queryByText("Cancels at period end")).toBeNull();
    });

    it("shows billing interval 'monthly'", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.getByText(/monthly/i)).toBeTruthy();
    });

    it("shows billing interval 'yearly' when billingInterval=year", () => {
      render(
        <SubscriptionSummary
          subscription={{ ...subscription, billingInterval: "year" as const }}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.getByText(/yearly/i)).toBeTruthy();
    });

    it("shows seat count", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.getByText("3")).toBeTruthy();
    });

    it("shows card on file with brand and last4 when defaultCard is provided", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={true}
          defaultCard={{ brand: "visa", last4: "4242", expMonth: 12, expYear: 2027 }}
        />,
      );
      expect(screen.getByText(/visa/i)).toBeTruthy();
      expect(screen.getByText(/4242/)).toBeTruthy();
    });

    it("does NOT show card on file when defaultCard is not provided", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.queryByTestId("credit-card-icon")).toBeNull();
    });

    it("hides seat control when canManageBilling=false", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={false}
        />,
      );
      // Input for seat control should not be present
      expect(screen.queryByRole("spinbutton")).toBeNull();
    });

    it("shows seat control when canManageBilling=true", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      // Seat number input
      expect(screen.getByRole("spinbutton")).toBeTruthy();
    });

    it("shows 'Cancel subscription' button when not canceling", () => {
      render(
        <SubscriptionSummary
          subscription={{ ...subscription, cancelAtPeriodEnd: false }}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.getByText("Cancel subscription")).toBeTruthy();
    });

    it("shows 'Reactivate subscription' button when cancelAtPeriodEnd=true", () => {
      render(
        <SubscriptionSummary
          subscription={{ ...subscription, cancelAtPeriodEnd: true }}
          orgSlug="acme"
          canManageBilling={true}
        />,
      );
      expect(screen.getByText("Reactivate subscription")).toBeTruthy();
    });

    it("hides cancel/reactivate buttons when canManageBilling=false", () => {
      render(
        <SubscriptionSummary
          subscription={subscription}
          orgSlug="acme"
          canManageBilling={false}
        />,
      );
      expect(screen.queryByText("Cancel subscription")).toBeNull();
      expect(screen.queryByText("Reactivate subscription")).toBeNull();
    });
  });
});
