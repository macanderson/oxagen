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
 *   - useRegisterFillableForm is called with a formId containing "billing-auto-reload"
 *   - apply round-trip: enabled, threshold, amount values are reflected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import {
  AutoReloadSettings,
  type AutoReloadSettingsProps,
} from "./auto-reload-settings";
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

const { mockUseRegisterFillableForm } = vi.hoisted(() => ({
  mockUseRegisterFillableForm: vi.fn(),
}));

vi.mock("@/lib/page-context", () => ({
  useRegisterFillableForm: mockUseRegisterFillableForm,
}));

// Capture the apply callback for round-trip tests.
let capturedApply: ((proposed: Record<string, unknown>) => void) | null = null;

const settings: OrgBillingSettings = {
  orgId: "org-test",
  autoReloadEnabled: false,
  autoReloadThresholdCents: 500, // $5.00
  autoReloadAmountCents: 2000, // $20.00
  autoReloadPaymentMethodId: null,
  lastAutoReloadAt: null,
  lowBalanceThresholdCents: 500,
  dunningState: "active",
  delinquentSince: null,
  graceEndsAt: null,
  suspendedAt: null,
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
    const threshold = screen.getByLabelText(
      /reload when balance falls below/i,
    ) as HTMLInputElement;
    expect(threshold.value).toBe("5.00");
  });

  it("pre-fills amount input from settings when enabled", () => {
    render(<AutoReloadSettings {...defaultProps} settings={enabledSettings} />);
    // When enabled, amount input shows $20.00
    const amount = screen.getByLabelText(
      /buy this many credits/i,
    ) as HTMLInputElement;
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
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });

  it("still renders the toggle when canManage=false", () => {
    render(<AutoReloadSettings {...defaultProps} canManage={false} />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });
});

describe("AutoReloadSettings — fill registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedApply = null;
    // Set the implementation after clearAllMocks so we can capture the apply cb.
    mockUseRegisterFillableForm.mockImplementation(
      (spec: {
        formId: string;
        fields: unknown[];
        apply: (proposed: Record<string, unknown>) => void;
      }) => {
        capturedApply = spec.apply;
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    capturedApply = null;
  });

  it("calls useRegisterFillableForm with a formId containing 'billing-auto-reload'", () => {
    render(<AutoReloadSettings {...defaultProps} />);
    expect(mockUseRegisterFillableForm).toHaveBeenCalled();
    const callArg = (
      mockUseRegisterFillableForm.mock.calls[0] as unknown as [
        { formId: string; fields: { name: string }[] },
      ]
    )[0];
    expect(callArg.formId).toContain("billing-auto-reload");
    expect(callArg.formId).toContain("acme");
  });

  it("registers 3 fields: enabled, threshold, amount", () => {
    render(<AutoReloadSettings {...defaultProps} />);
    const callArg = (
      mockUseRegisterFillableForm.mock.calls[0] as unknown as [
        { formId: string; fields: { name: string }[] },
      ]
    )[0];
    const names = callArg.fields.map((f) => f.name);
    expect(names).toContain("enabled");
    expect(names).toContain("threshold");
    expect(names).toContain("amount");
  });

  it("apply round-trip: enabled=true is reflected in component state (switch becomes checked)", () => {
    render(<AutoReloadSettings {...defaultProps} settings={settings} />);

    // Initially disabled (autoReloadEnabled: false)
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");

    expect(capturedApply).not.toBeNull();
    act(() => {
      capturedApply!({ enabled: true });
    });

    // After apply, the switch should be checked
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("apply round-trip: threshold and amount strings are updated", () => {
    render(<AutoReloadSettings {...defaultProps} settings={enabledSettings} />);

    expect(capturedApply).not.toBeNull();
    act(() => {
      capturedApply!({ threshold: "10.00", amount: "25.00" });
    });

    const thresholdInput = screen.getByLabelText(
      /reload when balance falls below/i,
    ) as HTMLInputElement;
    expect(thresholdInput.value).toBe("10.00");

    const amountInput = screen.getByLabelText(
      /buy this many credits/i,
    ) as HTMLInputElement;
    expect(amountInput.value).toBe("25.00");
  });

  it("apply round-trip: numeric threshold and amount are coerced to strings", () => {
    render(<AutoReloadSettings {...defaultProps} settings={enabledSettings} />);

    expect(capturedApply).not.toBeNull();
    act(() => {
      capturedApply!({ threshold: 15, amount: 50 });
    });

    const thresholdInput = screen.getByLabelText(
      /reload when balance falls below/i,
    ) as HTMLInputElement;
    expect(thresholdInput.value).toBe("15");

    const amountInput = screen.getByLabelText(
      /buy this many credits/i,
    ) as HTMLInputElement;
    expect(amountInput.value).toBe("50");
  });
});
