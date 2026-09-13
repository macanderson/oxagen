// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  ),
}));

const mockLoadStripe = vi.fn().mockResolvedValue(null);

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: mockLoadStripe,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => (
    <div role="alert">{children}</div>
  ),
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span />,
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(cleanup);

// Import after mocks are registered
const { StripeElementsProvider } = await import(
  "@/components/billing/stripe-elements-provider"
);

describe("StripeElementsProvider", () => {
  describe("when publishableKey is undefined", () => {
    it("renders a warning alert when publishableKey is undefined", () => {
      render(
        <StripeElementsProvider
          publishableKey={undefined}
          clientSecret="secret_123"
        >
          <div>child content</div>
        </StripeElementsProvider>,
      );
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    it("alert mentions STRIPE publishable key not configured", () => {
      render(
        <StripeElementsProvider
          publishableKey={undefined}
          clientSecret="secret_123"
        >
          <div>child content</div>
        </StripeElementsProvider>,
      );
      expect(
        screen.getByText(/STRIPE publishable key not configured/i),
      ).toBeTruthy();
    });

    it("does not render the Elements wrapper", () => {
      render(
        <StripeElementsProvider
          publishableKey={undefined}
          clientSecret="secret_123"
        >
          <div>child content</div>
        </StripeElementsProvider>,
      );
      expect(screen.queryByTestId("stripe-elements")).toBeNull();
    });

    it("does not render children", () => {
      render(
        <StripeElementsProvider
          publishableKey={undefined}
          clientSecret="secret_123"
        >
          <div data-testid="child-content">child content</div>
        </StripeElementsProvider>,
      );
      expect(screen.queryByTestId("child-content")).toBeNull();
    });
  });

  describe("when publishableKey is provided", () => {
    // Each test uses a unique key to avoid the module-scope stripePromiseCache
    // serving a cached promise before the spy has had a chance to record a call.
    let keyCounter = 0;
    function uniqueKey() {
      return `pk_test_unique_${++keyCounter}_${Date.now()}`;
    }

    it("renders children inside Elements", () => {
      render(
        <StripeElementsProvider
          publishableKey={uniqueKey()}
          clientSecret="secret_123"
        >
          <div data-testid="child-content">child content</div>
        </StripeElementsProvider>,
      );
      expect(screen.getByTestId("stripe-elements")).toBeTruthy();
      expect(screen.getByTestId("child-content")).toBeTruthy();
    });

    it("does not render a warning alert", () => {
      render(
        <StripeElementsProvider
          publishableKey={uniqueKey()}
          clientSecret="secret_123"
        >
          <div>child content</div>
        </StripeElementsProvider>,
      );
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("calls loadStripe with the provided key", () => {
      const key = uniqueKey();
      render(
        <StripeElementsProvider publishableKey={key} clientSecret="secret_123">
          <div>child</div>
        </StripeElementsProvider>,
      );
      expect(mockLoadStripe).toHaveBeenCalledWith(key);
    });

    it("memoizes the stripe promise — calls loadStripe only once for the same key", () => {
      // Use a fresh key so it is definitely not already in the module-scope cache.
      const memoKey = uniqueKey();
      // Count calls for this key before the first render
      const callsBefore = mockLoadStripe.mock.calls.filter(
        (args: string[]) => args[0] === memoKey,
      ).length;

      render(
        <StripeElementsProvider
          publishableKey={memoKey}
          clientSecret="secret_a"
        >
          <div>first</div>
        </StripeElementsProvider>,
      );
      cleanup();
      render(
        <StripeElementsProvider
          publishableKey={memoKey}
          clientSecret="secret_b"
        >
          <div>second</div>
        </StripeElementsProvider>,
      );

      const callsAfter = mockLoadStripe.mock.calls.filter(
        (args: string[]) => args[0] === memoKey,
      ).length;

      // loadStripe should have been invoked exactly once for this key
      expect(callsAfter - callsBefore).toBe(1);
    });
  });
});
