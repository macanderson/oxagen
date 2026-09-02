// @vitest-environment jsdom
/**
 * plans-grid.test.tsx — unit tests for PlansGrid component.
 *
 * Covers:
 *   - Renders all plan cards
 *   - Plan with currentPlanSlug has relation="current"
 *   - Plan cheaper than current has relation="downgrade"
 *   - Plan more expensive than current has relation="upgrade"
 *   - Plans at same tier level have relation="switch"
 *   - Clicking a plan card triggers previewPlanAction
 *   - Preview modal appears with charge details (isCharge=true)
 *   - Preview modal appears with credit details (isCharge=false)
 *   - Preview modal shows card brand/last4 when card is present
 *   - Preview modal shows "your card on file" when no card
 *   - Confirming triggers changePlanAction
 *   - changePlanAction error shows toast
 *   - changePlanAction success (no url) shows success toast and dismisses modal
 *   - changePlanAction success (with url) redirects
 *   - requiresCheckout=true goes straight to changePlanAction
 *   - previewPlanAction error shows toast
 *   - Current plan slug skips preview (no action call)
 *   - Cancel button closes modal
 *   - Interval tabs render (Monthly / Annual)
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import type { Plan } from "@/components/billing/plan-card";
import type { PlanChangePreview } from "@oxagen/billing";

afterEach(cleanup);

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockChangePlanAction, mockPreviewPlanAction } = vi.hoisted(() => ({
  mockChangePlanAction: vi.fn(),
  mockPreviewPlanAction: vi.fn(),
}));
const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("./actions", () => ({
  changePlanAction: mockChangePlanAction,
  previewPlanAction: mockPreviewPlanAction,
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockToast }),
}));

vi.mock("@oxagen/billing", () => ({}));

vi.mock("@/lib/utils", () => ({
  formatCents: (cents: number) => `$${(cents / 100).toFixed(2)}`,
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
}));

vi.mock(
  "lucide-react",
  () =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : () => <svg aria-hidden="true" data-icon={String(prop)} />,
      has: (_t, prop) => prop !== "then",
    }),
);

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant: _v,
    size: _s,
    className: _c,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

// Hoisted ref for the current dialog's onOpenChange so DialogClose can call it
const { dialogCloseRef } = vi.hoisted(() => ({
  dialogCloseRef: { current: null as ((open: boolean) => void) | null },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    // Register the handler so DialogClose can reach it
    dialogCloseRef.current = onOpenChange ?? null;
    return (
      <div data-testid="dialog" data-open={open ? "true" : "false"}>
        {open ? children : null}
      </div>
    );
  },
  DialogPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogPanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogClose: ({
    children,
    onClick,
    render: _r,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    render?: React.ReactElement;
  }) => (
    <button
      onClick={() => {
        onClick?.();
        dialogCloseRef.current?.(false);
      }}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    children,
    value: _v,
    onValueChange: _ovc,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div role="tablist">{children}</div>
  ),
  TabsTab: ({
    children,
    value: _v,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <button role="tab">{children}</button>,
  TabsPanel: ({
    children,
    value: _v,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <div role="tabpanel">{children}</div>,
  TabsIndicator: () => null,
}));

vi.mock("@/components/billing/plan-card", () => ({
  PlanCard: ({
    plan,
    relation,
    onSelect,
    interval,
  }: {
    plan: Plan;
    relation: string;
    onSelect: (slug: string, interval: "month" | "year") => void;
    interval: "month" | "year";
    pending?: boolean;
  }) => (
    <div data-testid="plan-card" data-slug={plan.slug} data-relation={relation}>
      <button onClick={() => onSelect(plan.slug, interval)}>{plan.name}</button>
    </div>
  ),
}));

// ── Test fixtures ─────────────────────────────────────────────────────────────

import { PlansGrid } from "./plans-grid";

const makePlan = (
  overrides: Partial<Plan> & { slug: string; tier: string; name: string },
): Plan => ({
  publicId: overrides.slug,
  monthlyCents: 2000,
  annualCents: 20000,
  includedCreditCents: 500,
  includedSeats: 1,
  features: [],
  ...overrides,
});

const freePlan = makePlan({
  slug: "free-plan",
  tier: "free",
  name: "Free",
  monthlyCents: 0,
  annualCents: 0,
});
const buildPlan = makePlan({
  slug: "build-plan",
  tier: "build",
  name: "Build",
  monthlyCents: 2000,
});
const scalePlan = makePlan({
  slug: "scale-plan",
  tier: "scale",
  name: "Scale",
  monthlyCents: 9900,
});

const defaultPlans = [freePlan, buildPlan, scalePlan];

const makePreview = (
  overrides: Partial<PlanChangePreview> = {},
): PlanChangePreview => ({
  requiresCheckout: false,
  isCharge: true,
  amountCents: 1500,
  prorationDate: 1751328000, // Unix timestamp (seconds) for 2026-01-01
  targetPlanSlug: "scale-plan",
  interval: "month",
  currency: "usd",
  card: null,
  ...overrides,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderGrid(
  props: Partial<React.ComponentProps<typeof PlansGrid>> = {},
) {
  return render(
    <PlansGrid
      orgSlug="acme"
      currentPlanSlug="build-plan"
      currentTier="build"
      plans={defaultPlans}
      {...props}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PlansGrid — rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all plan cards", () => {
    renderGrid();
    const cards = screen.getAllByTestId("plan-card");
    expect(cards).toHaveLength(3);
  });

  it("renders the current tier label in header", () => {
    renderGrid({ currentTier: "enterprise" });
    // "enterprise" appears in the "You're on the enterprise plan" header text
    expect(screen.getByText(/enterprise/i)).toBeInTheDocument();
  });

  it("renders Monthly and Annual tab options", () => {
    renderGrid();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
    expect(screen.getByText("Annual")).toBeInTheDocument();
  });

  it("plan matching currentPlanSlug has relation='current'", () => {
    renderGrid({ currentPlanSlug: "build-plan", currentTier: "build" });
    const card = [...screen.getAllByTestId("plan-card")].find(
      (el) => el.getAttribute("data-slug") === "build-plan",
    );
    expect(card?.getAttribute("data-relation")).toBe("current");
  });

  it("plan cheaper than current has relation='downgrade'", () => {
    renderGrid({ currentPlanSlug: "scale-plan", currentTier: "scale" });
    const buildCard = [...screen.getAllByTestId("plan-card")].find(
      (el) => el.getAttribute("data-slug") === "build-plan",
    );
    expect(buildCard?.getAttribute("data-relation")).toBe("downgrade");
  });

  it("plan more expensive than current has relation='upgrade'", () => {
    renderGrid({ currentPlanSlug: "build-plan", currentTier: "build" });
    const scaleCard = [...screen.getAllByTestId("plan-card")].find(
      (el) => el.getAttribute("data-slug") === "scale-plan",
    );
    expect(scaleCard?.getAttribute("data-relation")).toBe("upgrade");
  });

  it("plan at same tier as current but different slug has relation='switch'", () => {
    const build2 = makePlan({
      slug: "build-plan-v2",
      tier: "build",
      name: "Build V2",
      monthlyCents: 2500,
    });
    renderGrid({
      currentPlanSlug: "build-plan",
      currentTier: "build",
      plans: [buildPlan, build2],
    });
    const v2Card = [...screen.getAllByTestId("plan-card")].find(
      (el) => el.getAttribute("data-slug") === "build-plan-v2",
    );
    expect(v2Card?.getAttribute("data-relation")).toBe("switch");
  });

  it("defaults currentTier to 'free' when not provided", () => {
    renderGrid({ currentTier: undefined, currentPlanSlug: null });
    const scaleCard = [...screen.getAllByTestId("plan-card")].find(
      (el) => el.getAttribute("data-slug") === "scale-plan",
    );
    // Scale is above free → upgrade
    expect(scaleCard?.getAttribute("data-relation")).toBe("upgrade");
  });
});

describe("PlansGrid — plan selection with preview (subscription exists)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clicking a non-current plan card calls previewPlanAction", async () => {
    const preview = makePreview();
    mockPreviewPlanAction.mockResolvedValue(preview);

    renderGrid();
    const scaleButton = screen.getByRole("button", { name: /scale/i });

    await act(async () => {
      fireEvent.click(scaleButton);
    });

    expect(mockPreviewPlanAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      targetPlanSlug: "scale-plan",
      interval: "month",
    });
  });

  it("clicking the current plan card does not call previewPlanAction", async () => {
    renderGrid({ currentPlanSlug: "build-plan" });
    const buildButton = screen.getByRole("button", { name: /build/i });

    await act(async () => {
      fireEvent.click(buildButton);
    });

    expect(mockPreviewPlanAction).not.toHaveBeenCalled();
  });

  it("preview modal appears with charge details when isCharge=true", async () => {
    const preview = makePreview({
      requiresCheckout: false,
      isCharge: true,
      amountCents: 1500,
      prorationDate: 1752624000,
      card: null,
    });
    mockPreviewPlanAction.mockResolvedValue(preview);

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/confirm plan change/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/will charge/i)).toBeInTheDocument();
    expect(screen.getByText(/\$15\.00/)).toBeInTheDocument();
  });

  it("preview modal shows credit text when isCharge=false", async () => {
    const preview = makePreview({
      requiresCheckout: false,
      isCharge: false,
      amountCents: 500,
      prorationDate: 1752624000,
    });
    mockPreviewPlanAction.mockResolvedValue(preview);

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/credit/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();
  });

  it("preview modal shows card brand and last4 when card is present", async () => {
    const preview = makePreview({
      requiresCheckout: false,
      isCharge: true,
      amountCents: 1000,
      prorationDate: 1748736000,
      card: { brand: "Visa", last4: "4242" },
    });
    mockPreviewPlanAction.mockResolvedValue(preview);

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Visa/)).toBeInTheDocument();
    });
    expect(screen.getByText(/4242/)).toBeInTheDocument();
  });

  it("preview modal shows 'your card on file' when card is null", async () => {
    const preview = makePreview({
      requiresCheckout: false,
      isCharge: true,
      amountCents: 1000,
      prorationDate: 1748736000,
      card: null,
    });
    mockPreviewPlanAction.mockResolvedValue(preview);

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/your card on file/i)).toBeInTheDocument();
    });
  });

  it("previewPlanAction error shows toast", async () => {
    mockPreviewPlanAction.mockResolvedValue({ error: "Preview failed" });

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not preview plan change",
          type: "error",
        }),
      );
    });
  });
});

describe("PlansGrid — confirmation dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirming calls changePlanAction with correct args", async () => {
    const preview = makePreview({ requiresCheckout: false });
    mockPreviewPlanAction.mockResolvedValue(preview);
    mockChangePlanAction.mockResolvedValue({ ok: true, url: null });

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/confirm plan change/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    });

    await waitFor(() => {
      expect(mockChangePlanAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        targetPlanSlug: "scale-plan",
        interval: "month",
      });
    });
  });

  it("changePlanAction success with no url shows success toast and dismisses modal", async () => {
    const preview = makePreview({ requiresCheckout: false });
    mockPreviewPlanAction.mockResolvedValue(preview);
    mockChangePlanAction.mockResolvedValue({ ok: true, url: null });

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/confirm plan change/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Plan updated",
          type: "success",
        }),
      );
    });

    // Modal should be gone
    await waitFor(() => {
      expect(
        screen.queryByText(/confirm plan change/i),
      ).not.toBeInTheDocument();
    });
  });

  it("changePlanAction success with url redirects via window.location.href", async () => {
    const originalLocation = window.location;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).location;
    (window as { location: { href: string } }).location = { href: "" };

    const preview = makePreview({ requiresCheckout: false });
    mockPreviewPlanAction.mockResolvedValue(preview);
    mockChangePlanAction.mockResolvedValue({
      ok: true,
      url: "https://checkout.stripe.com/pay/cs_test",
    });

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/confirm plan change/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    });

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/pay/cs_test",
      );
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).location = originalLocation;
  });

  it("changePlanAction error shows toast and dismisses modal", async () => {
    const preview = makePreview({ requiresCheckout: false });
    mockPreviewPlanAction.mockResolvedValue(preview);
    mockChangePlanAction.mockResolvedValue({
      ok: false,
      error: "Payment declined",
    });

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/confirm plan change/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Plan change failed",
          description: "Payment declined",
          type: "error",
        }),
      );
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/confirm plan change/i),
      ).not.toBeInTheDocument();
    });
  });

  it("Cancel button closes the modal", async () => {
    const preview = makePreview({ requiresCheckout: false });
    mockPreviewPlanAction.mockResolvedValue(preview);

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/confirm plan change/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/confirm plan change/i),
      ).not.toBeInTheDocument();
    });
  });
});

describe("PlansGrid — requiresCheckout path (no existing subscription)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("goes straight to changePlanAction without showing the confirm dialog", async () => {
    const preview = makePreview({ requiresCheckout: true });
    mockPreviewPlanAction.mockResolvedValue(preview);
    mockChangePlanAction.mockResolvedValue({ ok: true, url: null });

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(mockChangePlanAction).toHaveBeenCalled();
    });

    // Should not show the dialog
    expect(screen.queryByText(/confirm plan change/i)).not.toBeInTheDocument();
  });

  it("shows error toast when changePlanAction fails on checkout path", async () => {
    const preview = makePreview({ requiresCheckout: true });
    mockPreviewPlanAction.mockResolvedValue(preview);
    mockChangePlanAction.mockResolvedValue({
      ok: false,
      error: "Checkout failed",
    });

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Plan change failed",
          description: "Checkout failed",
          type: "error",
        }),
      );
    });
  });

  it("redirects when changePlanAction returns url on checkout path", async () => {
    const originalLocation = window.location;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).location;
    (window as { location: { href: string } }).location = { href: "" };

    const preview = makePreview({ requiresCheckout: true });
    mockPreviewPlanAction.mockResolvedValue(preview);
    mockChangePlanAction.mockResolvedValue({
      ok: true,
      url: "https://checkout.stripe.com/pay/cs_new",
    });

    renderGrid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /scale/i }));
    });

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/pay/cs_new",
      );
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).location = originalLocation;
  });
});

describe("PlansGrid — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with no plans (empty array)", () => {
    renderGrid({ plans: [] });
    expect(screen.queryAllByTestId("plan-card")).toHaveLength(0);
  });

  it("renders correctly when currentPlanSlug is null", () => {
    renderGrid({ currentPlanSlug: null, currentTier: "free" });
    const cards = screen.getAllByTestId("plan-card");
    expect(cards).toHaveLength(3);
    // None should be "current"
    for (const card of cards) {
      expect(card.getAttribute("data-relation")).not.toBe("current");
    }
  });
});
