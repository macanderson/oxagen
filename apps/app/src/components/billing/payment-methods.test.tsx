// @vitest-environment jsdom
/**
 * payment-methods.test.tsx — unit tests for the AddCardForm sync-error path.
 *
 * The CRITICAL bug: when syncPaymentMethodsAction throws after Stripe's
 * confirmSetup succeeds, the original code swallowed the error silently
 * (try/finally, no catch). The fix wraps the sync call in its own try/catch
 * and surfaces a user-visible error toast.
 *
 * AddCardForm is an internal component, so we test through the full
 * PaymentMethods render tree. Stripe hooks are mocked so we can drive the
 * submit path without a real Stripe.js instance.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";

afterEach(cleanup);

// ── Stripe mocks ────────────────────────────────────────────────────────────

const mockConfirmSetup = vi.fn();
vi.mock("@stripe/react-stripe-js", () => ({
  useStripe: () => ({ confirmSetup: mockConfirmSetup }),
  useElements: () => ({}),
  PaymentElement: () => <div data-testid="payment-element" />,
  Elements: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── Action mocks ────────────────────────────────────────────────────────────

const mockSyncPaymentMethods = vi.fn();
const mockCreateSetupIntent = vi.fn();
const mockSetDefault = vi.fn();
const mockRemove = vi.fn();

vi.mock("@/app/[orgSlug]/billing/actions", () => ({
  syncPaymentMethodsAction: (...args: unknown[]) =>
    mockSyncPaymentMethods(...args),
  createSetupIntentAction: (...args: unknown[]) =>
    mockCreateSetupIntent(...args),
  setDefaultPaymentMethodAction: (...args: unknown[]) =>
    mockSetDefault(...args),
  removePaymentMethodAction: (...args: unknown[]) => mockRemove(...args),
}));

// ── Toast mock ──────────────────────────────────────────────────────────────

const toastAdd = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}));

// ── Navigation mock ─────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// ── UI stubs ────────────────────────────────────────────────────────────────

vi.mock("@/components/ui/panel", () => ({
  Panel: ({
    children,
    actions,
  }: {
    children: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: (
    props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string },
  ) => <button {...props}>{props.children}</button>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
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
}));
vi.mock("./stripe-elements-provider", () => ({
  StripeElementsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("lucide-react", () => ({
  CreditCard: () => null,
  Star: () => null,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

async function openAddCardDialog() {
  const { PaymentMethods } = await import("./payment-methods");
  render(
    <PaymentMethods
      orgSlug="acme"
      methods={[]}
      publishableKey="pk_test_123"
      canManage={true}
    />,
  );

  // Open the dialog
  await userEvent.click(screen.getByRole("button", { name: /add card/i }));
  // Dialog becomes visible
  await screen.findByRole("dialog");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AddCardForm — sync success path", () => {
  beforeEach(() => {
    toastAdd.mockClear();
    mockConfirmSetup.mockResolvedValue({ error: undefined });
    mockSyncPaymentMethods.mockResolvedValue({ ok: true });
    mockCreateSetupIntent.mockResolvedValue({
      ok: true,
      clientSecret: "cs_test_123",
    });
  });

  it("shows success toast when confirmSetup and sync both succeed", async () => {
    await openAddCardDialog();

    const form = screen.getByRole("dialog").querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true }));
    });

    await waitFor(() => {
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Card saved", type: "success" }),
      );
    });
    expect(mockSyncPaymentMethods).toHaveBeenCalledWith({ orgSlug: "acme" });
  });
});

describe("AddCardForm — CRITICAL: sync failure after Stripe confirmSetup success", () => {
  beforeEach(() => {
    toastAdd.mockClear();
    // Stripe confirms successfully — card IS live in Stripe
    mockConfirmSetup.mockResolvedValue({ error: undefined });
    // But the DB mirror sync throws
    mockSyncPaymentMethods.mockRejectedValue(new Error("DB write failed"));
    mockCreateSetupIntent.mockResolvedValue({
      ok: true,
      clientSecret: "cs_test_456",
    });
  });

  it("shows an error toast (not a success toast) when sync fails", async () => {
    await openAddCardDialog();

    const form = screen.getByRole("dialog").querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true }));
    });

    await waitFor(() => {
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    });
  });

  it("does NOT call the success-path toast when sync fails", async () => {
    await openAddCardDialog();

    const form = screen.getByRole("dialog").querySelector("form");
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true }));
    });

    await waitFor(() => {
      // The error toast must have fired
      expect(toastAdd).toHaveBeenCalled();
    });

    // No "Card saved" success toast — only the error toast
    const successCalls = toastAdd.mock.calls.filter(
      (call) =>
        (call[0] as { title?: string } | undefined)?.title === "Card saved",
    );
    expect(successCalls).toHaveLength(0);
  });

  it("includes Stripe-sync messaging in the error toast so the user understands the state", async () => {
    await openAddCardDialog();

    const form = screen.getByRole("dialog").querySelector("form");
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true }));
    });

    await waitFor(() => {
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: expect.stringContaining("Stripe"),
        }),
      );
    });
  });
});

describe("AddCardForm — Stripe confirmSetup error path (pre-existing)", () => {
  beforeEach(() => {
    toastAdd.mockClear();
    mockConfirmSetup.mockResolvedValue({
      error: { message: "Your card was declined." },
    });
    mockCreateSetupIntent.mockResolvedValue({
      ok: true,
      clientSecret: "cs_test_789",
    });
  });

  it("shows a Stripe error toast when confirmSetup returns an error", async () => {
    await openAddCardDialog();

    const form = screen.getByRole("dialog").querySelector("form");
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true }));
    });

    await waitFor(() => {
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Card not saved",
        }),
      );
    });
    // Sync was never called — Stripe failed first
    expect(mockSyncPaymentMethods).not.toHaveBeenCalled();
  });
});
