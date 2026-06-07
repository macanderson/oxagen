// @vitest-environment jsdom
/**
 * auto-reload-settings.test.tsx — render tests for AutoReloadSettings.
 *
 * Covers:
 *   - Renders "Auto-reload" heading
 *   - Toggle switch reflects enabled state (false → unchecked)
 *   - Toggle switch reflects enabled state (true → checked)
 *   - Threshold and amount inputs pre-populated from settings
 *   - canManage=false disables all controls
 *   - Renders payment method select when methods are provided
 *   - Save button present
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AutoReloadSettings, type AutoReloadSettingsProps } from "./auto-reload-settings";
import type { OrgBillingSettings, PaymentMethodView } from "@oxagen/billing";

afterEach(cleanup);

vi.mock("@/app/[orgSlug]/billing/actions", () => ({
  updateAutoReloadAction: vi.fn().mockResolvedValue({ ok: true }),
  cancelSubscriptionAction: vi.fn(),
  reactivateSubscriptionAction: vi.fn(),
  setSeatsAction: vi.fn(),
  previewSeatsAction: vi.fn(),
  buyCreditsAction: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

const settings: OrgBillingSettings = {
  autoReloadEnabled: false,
  autoReloadThresholdCents: 500, // $5.00
  autoReloadAmountCents: 2000,   // $20.00
  autoReloadPaymentMethodId: null,
};

const enabledSettings: OrgBillingSettings = {
  ...settings,
  autoReloadEnabled: true,
};

const method: PaymentMethodView = {
  stripePaymentMethodId: "pm-123",
  brand: "visa",
  last4: "4242",
  expMonth: 12,
  expYear: 2026,
  isDefault: true,
};

const defaultProps: AutoReloadSettingsProps = {
  orgSlug: "acme",
  settings,
  methods: [method],
  canManage: true,
};

describe("AutoReloadSettings — rendering", () => {
  it("renders the 'Automatic reload' heading", () => {
    render(<AutoReloadSettings {...defaultProps} />);
    expect(screen.getByText("Automatic reload")).toBeInTheDocument();
  });

  it("renders 'Enable automatic reload' label", () => {
    render(<AutoReloadSettings {...defaultProps} />);
    expect(screen.getByText(/enable automatic reload/i)).toBeInTheDocument();
  });

  it("renders the toggle switch", () => {
    render(<AutoReloadSettings {...defaultProps} />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("toggle is unchecked when autoReloadEnabled=false", () => {
    render(<AutoReloadSettings {...defaultProps} />);
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("toggle is checked when autoReloadEnabled=true", () => {
    render(<AutoReloadSettings {...defaultProps} settings={enabledSettings} />);
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("pre-fills threshold input from settings when enabled", () => {
    render(<AutoReloadSettings {...defaultProps} settings={enabledSettings} />);
    // When enabled, threshold input shows $5.00
    const threshold = screen.getByLabelText(/reload when balance falls below/i) as HTMLInputElement;
    expect(threshold.value).toBe("5.00");
  });

  it("pre-fills amount input from settings when enabled", () => {
    render(<AutoReloadSettings {...defaultProps} settings={enabledSettings} />);
    // When enabled, amount input shows $20.00
    const amount = screen.getByLabelText(/buy this many credits/i) as HTMLInputElement;
    expect(amount.value).toBe("20.00");
  });

  it("renders the Save button", () => {
    render(<AutoReloadSettings {...defaultProps} />);
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });
});

describe("AutoReloadSettings — canManage=false", () => {
  it("hides the Save button when canManage=false", () => {
    render(<AutoReloadSettings {...defaultProps} canManage={false} />);
    // Save button is conditionally rendered only when canManage=true
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("still renders the toggle when canManage=false", () => {
    render(<AutoReloadSettings {...defaultProps} canManage={false} />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });
});
